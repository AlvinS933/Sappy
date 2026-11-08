// Runs Kokoro text-to-speech in a separate process so the Electron main
// process (and therefore the window) never freezes while audio is generated.
import { env } from '@huggingface/transformers'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'
import { onParentMessage, postToParent, waitForInit } from './child-port'

type TtsConfig = { model: string; dtype: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'; voice: string; speed: number }

export type WorkerRequest =
  | { type: 'init'; modelsDir: string; config: TtsConfig }
  | { type: 'speak'; id: number; text: string }
  | { type: 'cancel'; id: number }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'chunk'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'done'; id: number }
  | { type: 'error'; id?: number; message: string }

const post = (msg: WorkerResponse, transfer: ArrayBuffer[] = []) => postToParent(msg, transfer)

const cancelled = new Set<number>()
let queue = Promise.resolve()

// Turn chat-style text into something that sounds natural when read aloud.
function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')            // code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // [link](url) -> link
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // headings
    .replace(/^\s*[-*+]\s+/gm, '')               // bullet markers
    .replace(/^\s*(\d+)\.\s+/gm, '$1, ')         // "1. " -> "1, "
    .replace(/[*_`~>|]/g, '')                    // emphasis, code, quotes, tables
    .replace(/\p{Extended_Pictographic}/gu, '')  // emoji
    .replace(/\s+\n/g, '\n')
    .trim()
}

const init = waitForInit<Extract<WorkerRequest, { type: 'init' }>>()
const ttsPromise = init.then(({ modelsDir, config }) => {
  // Load model files only from disk — never download at runtime.
  env.cacheDir = modelsDir
  env.localModelPath = modelsDir
  env.allowRemoteModels = false
  return KokoroTTS.from_pretrained(config.model, { dtype: config.dtype, device: 'cpu' })
})
ttsPromise.then(
  () => post({ type: 'ready' }),
  (err) => post({ type: 'error', message: `Failed to load TTS model: ${err?.message ?? err}` }),
)

async function speak(id: number, text: string) {
  try {
    const tts = await ttsPromise
    const { config } = await init
    const speakable = toSpeakable(text)
    if (!speakable || cancelled.has(id)) return
    // stream() splits into sentences and yields audio for each one as soon as it's ready.
    // We build and close the splitter ourselves: kokoro-js 1.2.1 never closes it when
    // given a plain string, so the last sentence would never be spoken.
    const splitter = new TextSplitterStream()
    splitter.push(speakable)
    splitter.close()
    for await (const { audio } of tts.stream(splitter, { voice: config.voice as 'af_heart', speed: config.speed })) {
      if (cancelled.has(id)) break
      const samples = audio.audio as Float32Array
      post({ type: 'chunk', id, samples, sampleRate: audio.sampling_rate }, [samples.buffer as ArrayBuffer])
    }
  } catch (err) {
    post({ type: 'error', id, message: (err as Error)?.message ?? String(err) })
  } finally {
    cancelled.delete(id)
    post({ type: 'done', id })
  }
}

onParentMessage((raw) => {
  const msg = raw as WorkerRequest
  if (msg.type === 'cancel') {
    cancelled.add(msg.id)
  } else if (msg.type === 'speak') {
    // One utterance at a time, in order.
    queue = queue.then(() => speak(msg.id, msg.text))
  }
})
