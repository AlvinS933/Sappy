import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type VoiceStatus = 'loading' | 'idle' | 'recording' | 'transcribing' | 'error'

// Collects microphone audio into 80 ms frames (1280 samples @ 16 kHz).
// Runs on the browser's audio thread, so it's written as a string here.
const WORKLET = `
class MicFrames extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1280); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === 1280) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(1280); this.n = 0 }
      }
    }
    return true
  }
}
registerProcessor('mic-frames', MicFrames)
`

type Options = {
  /** Called with the transcribed text when the patient finishes speaking. */
  onTranscript: (text: string) => void
  /** Called when the wake word is heard. */
  onWake?: () => void
  /** Start listening for the wake word as soon as the voice models are loaded. */
  wakeOnStart?: boolean
}

export function useVoiceInput({ onTranscript, onWake, wakeOnStart = false }: Options) {
  const [status, setStatus] = useState<VoiceStatus>('loading')
  const [wakeEnabled, setWakeEnabledState] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [wakePhrase, setWakePhrase] = useState('')
  const micRef = useRef<{ ctx: AudioContext; stream: MediaStream } | null>(null)
  // Always call the latest callbacks without re-subscribing to voice events.
  const callbacks = useRef({ onTranscript, onWake })
  useLayoutEffect(() => {
    callbacks.current = { onTranscript, onWake }
  })

  const openMic = useCallback(async () => {
    if (micRef.current) return true
    try {
      if (!(await window.voice.requestMicAccess())) {
        setMicError('Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone.')
        return false
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const ctx = new AudioContext({ sampleRate: 16000 })
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      await ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)

      const node = new AudioWorkletNode(ctx, 'mic-frames')
      node.port.onmessage = (e: MessageEvent<Float32Array>) => window.voice.pushFrame(e.data)
      const mute = ctx.createGain()
      mute.gain.value = 0 // keep the graph running without playing the mic through the speakers
      ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination)

      micRef.current = { ctx, stream }
      setMicError(null)
      return true
    } catch (err) {
      console.error('Microphone failed:', err)
      setMicError('Could not access the microphone.')
      return false
    }
  }, [])

  const closeMic = useCallback(() => {
    const mic = micRef.current
    if (!mic) return
    mic.stream.getTracks().forEach((t) => t.stop())
    void mic.ctx.close()
    micRef.current = null
  }, [])

  useEffect(() => {
    const off = window.voice.onEvent((event) => {
      switch (event.type) {
        case 'ready':
          setStatus('idle')
          break
        case 'loading':
          setStatus('loading')
          break
        case 'error':
          console.error('[voice]', event.message)
          setStatus('error')
          break
        case 'state':
          setStatus(event.state)
          break
        case 'wake':
          callbacks.current.onWake?.()
          break
        case 'transcript':
          callbacks.current.onTranscript(event.text)
          break
      }
    })
    // Subscribe, and catch up if the models finished loading before this page did.
    void window.voice.connect().then(({ status: s, wakePhrase }) => {
      setWakePhrase(wakePhrase)
      if (s === 'ready') setStatus((cur) => (cur === 'loading' ? 'idle' : cur))
      else if (s === 'error') setStatus('error')
    })
    return () => {
      off()
      closeMic()
    }
  }, [closeMic])

  // The mic only needs to stay open while listening for the wake word or recording.
  useEffect(() => {
    if (!wakeEnabled && status === 'idle') closeMic()
  }, [wakeEnabled, status, closeMic])

  /** Mic button: start recording, or stop and transcribe if already recording. */
  const toggleRecording = useCallback(async () => {
    if (status === 'recording') {
      window.voice.stop()
    } else if (status === 'idle' && (await openMic())) {
      window.voice.start()
    }
  }, [status, openMic])

  const setWakeEnabled = useCallback(
    async (enabled: boolean) => {
      if (enabled && !(await openMic())) return
      setWakeEnabledState(enabled)
      window.voice.setWakeEnabled(enabled)
    },
    [openMic],
  )

  /** Ignore the wake word while the app is talking (so it doesn't hear itself). */
  const setPaused = useCallback((paused: boolean) => window.voice.setPaused(paused), [])

  // Turn wake-word listening on once at startup (the patient can still switch it off).
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!wakeOnStart || autoStarted.current || status !== 'idle') return
    autoStarted.current = true
    void setWakeEnabled(true)
  }, [wakeOnStart, status, setWakeEnabled])

  return { status, wakeEnabled, setWakeEnabled, toggleRecording, setPaused, micError, wakePhrase }
}

/** A short two-tone chime so the patient knows the app is listening. */
export function playChime() {
  const ctx = new AudioContext()
  const now = ctx.currentTime
  ;[660, 880].forEach((freq, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, now + i * 0.12)
    gain.gain.exponentialRampToValueAtTime(0.2, now + i * 0.12 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.2)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now + i * 0.12)
    osc.stop(now + i * 0.12 + 0.22)
  })
  setTimeout(() => void ctx.close(), 600)
}
