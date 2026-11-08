// Runs wake-word detection, voice activity detection and speech-to-text in a
// separate process, so the Electron main process never freezes.
import path from 'node:path'
import { env, pipeline } from '@huggingface/transformers'
import { WakeWordDetector } from './voice/wakeword'
import { SileroVad } from './voice/vad'
import { VoiceEngine, type EngineOptions, type VoiceEvent } from './voice/engine'
import { onParentMessage, postToParent, waitForInit } from './child-port'

type VoiceConfig = {
  stt: { model: string; dtype: 'fp32' | 'fp16' | 'q8' | 'q4' }
  wakeWord: { model: string; phrase: string; threshold: number }
}

export type VoiceWorkerRequest =
  | { type: 'init'; modelsDir: string; config: VoiceConfig }
  | { type: 'frame'; samples: Float32Array }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'wake-enabled'; enabled: boolean }
  | { type: 'paused'; paused: boolean }

export type VoiceWorkerResponse = VoiceEvent | { type: 'ready' } | { type: 'error'; message: string }

const post = (msg: VoiceWorkerResponse) => postToParent(msg)

const MAX_QUEUED_FRAMES = 50 // ~4 s; older audio is dropped if we fall behind

async function init() {
  const { modelsDir, config } = await waitForInit<Extract<VoiceWorkerRequest, { type: 'init' }>>()
  // Load model files only from disk — never download at runtime.
  env.cacheDir = modelsDir
  env.localModelPath = modelsDir
  env.allowRemoteModels = false

  const [wake, vad, asr] = await Promise.all([
    WakeWordDetector.create(path.join(modelsDir, 'openwakeword'), config.wakeWord.model),
    SileroVad.create(path.join(modelsDir, 'silero-vad', 'silero_vad.onnx')),
    pipeline('automatic-speech-recognition', config.stt.model, { dtype: config.stt.dtype, device: 'cpu' }),
  ])

  const transcribe = async (audio: Float32Array) => {
    const result = await asr(audio)
    return (Array.isArray(result) ? result[0] : result).text
  }

  const options: EngineOptions = {
    wakeThreshold: config.wakeWord.threshold,
    wakePhrase: config.wakeWord.phrase,
    speechThreshold: 0.5,
    endSilenceMs: 900,
    noSpeechTimeoutMs: 6000,
    maxRecordingMs: 20000,
  }
  return new VoiceEngine(wake, vad, transcribe, post, options)
}

const enginePromise = init()
enginePromise.then(
  () => post({ type: 'ready' }),
  (err) => post({ type: 'error', message: `Failed to load voice models: ${err?.message ?? err}` }),
)

// Process audio frames strictly in order (wake-word detection depends on continuity).
const frames: Float32Array[] = []
let draining = false
async function drain() {
  if (draining) return
  draining = true
  try {
    const engine = await enginePromise
    while (frames.length) await engine.pushFrame(frames.shift()!)
  } catch (err) {
    post({ type: 'error', message: (err as Error)?.message ?? String(err) })
  } finally {
    draining = false
  }
}

onParentMessage(async (raw) => {
  const msg = raw as VoiceWorkerRequest
  if (msg.type === 'init') return
  if (msg.type === 'frame') {
    frames.push(msg.samples)
    if (frames.length > MAX_QUEUED_FRAMES) frames.splice(0, frames.length - MAX_QUEUED_FRAMES)
    void drain()
    return
  }
  const engine = await enginePromise.catch(() => null)
  if (!engine) return
  if (msg.type === 'start') engine.startRecording()
  else if (msg.type === 'stop') void engine.stopRecording()
  else if (msg.type === 'cancel') engine.cancel()
  else if (msg.type === 'wake-enabled') engine.setWakeEnabled(msg.enabled)
  else if (msg.type === 'paused') engine.setPaused(msg.paused)
})
