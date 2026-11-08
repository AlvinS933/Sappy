import { useCallback, useEffect, useRef, useState } from 'react'

// Plays text-to-speech audio from the Electron TTS worker.
// Audio arrives one sentence at a time; each chunk is scheduled to start
// exactly when the previous one ends, so playback sounds continuous.
export function useSpeech() {
  const ctxRef = useRef<AudioContext | null>(null)
  const currentId = useRef<number | null>(null)
  const nextStart = useRef(0)
  const sources = useRef(new Set<AudioBufferSourceNode>())
  const [speaking, setSpeaking] = useState(false)
  // The sentence being heard right now (for captions / the companion's speech bubble).
  const [caption, setCaption] = useState<string | null>(null)
  const captionTimers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const finish = useCallback(() => {
    for (const t of captionTimers.current) clearTimeout(t)
    captionTimers.current.clear()
    setCaption(null)
    setSpeaking(false)
  }, [])

  const stop = useCallback(() => {
    if (currentId.current !== null) void window.tts.cancel(currentId.current)
    currentId.current = null
    for (const s of sources.current) s.stop()
    sources.current.clear()
    nextStart.current = 0
    finish()
  }, [finish])

  useEffect(() => {
    const offChunk = window.tts.onChunk(({ id, text, samples, sampleRate }) => {
      if (id !== currentId.current) return // stale audio from a cancelled utterance
      const ctx = (ctxRef.current ??= new AudioContext())
      const buffer = ctx.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(new Float32Array(samples), 0)

      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime, nextStart.current)
      source.start(startAt)
      nextStart.current = startAt + buffer.duration

      // Show this sentence's caption when its audio actually starts playing.
      const timer = setTimeout(() => {
        captionTimers.current.delete(timer)
        setCaption(text)
      }, Math.max(0, (startAt - ctx.currentTime) * 1000))
      captionTimers.current.add(timer)

      sources.current.add(source)
      source.onended = () => {
        sources.current.delete(source)
        // Finished when the last scheduled chunk ends and generation is done.
        if (sources.current.size === 0 && currentId.current === null) finish()
      }
    })

    const offDone = window.tts.onDone(({ id }) => {
      if (id !== currentId.current) return
      currentId.current = null
      if (sources.current.size === 0) finish()
    })

    return () => {
      offChunk()
      offDone()
    }
  }, [finish])

  const speak = useCallback(
    async (text: string) => {
      stop()
      setSpeaking(true)
      try {
        currentId.current = await window.tts.speak(text)
      } catch (err) {
        console.error('TTS failed:', err)
        finish()
      }
    },
    [stop, finish],
  )

  // Stop audio if the component unmounts.
  useEffect(() => stop, [stop])

  return { speak, stop, speaking, caption }
}
