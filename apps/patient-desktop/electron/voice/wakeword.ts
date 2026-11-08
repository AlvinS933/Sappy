// Streaming wake-word detection: a TypeScript port of openWakeWord's
// streaming pipeline (openwakeword/utils.py AudioFeatures + model.py predict).
//
//   16 kHz audio ─▶ melspectrogram.onnx ─▶ embedding_model.onnx ─▶ <wake word>.onnx ─▶ score 0..1
//
// Audio must arrive in frames of exactly FRAME_SIZE samples (80 ms).
import path from 'node:path'
import * as ort from 'onnxruntime-node'

export const FRAME_SIZE = 1280 // 80 ms @ 16 kHz
const MEL_CONTEXT = 160 * 3 // extra samples of context for each mel computation
const MEL_BINS = 32
const EMBED_WINDOW = 76 // mel frames per embedding
const EMBED_SIZE = 96
const WAKE_INPUT_FRAMES = 16 // embeddings per wake-word prediction
const MAX_MEL_FRAMES = 10 * 97
const MAX_FEATURE_FRAMES = 120
const WARMUP_FRAMES = 5 // openWakeWord ignores the first 5 predictions

const sessionOptions: ort.InferenceSession.SessionOptions = { intraOpNumThreads: 1, interOpNumThreads: 1 }

export class WakeWordDetector {
  private raw = new Float32Array(0)
  private mel: Float32Array[] = []
  private features: Float32Array[] = []
  private framesSinceReset = 0
  private melModel: ort.InferenceSession
  private embedModel: ort.InferenceSession
  private wakeModel: ort.InferenceSession

  private constructor(melModel: ort.InferenceSession, embedModel: ort.InferenceSession, wakeModel: ort.InferenceSession) {
    this.melModel = melModel
    this.embedModel = embedModel
    this.wakeModel = wakeModel
  }

  /** `dir` contains melspectrogram.onnx, embedding_model.onnx and the wake word model. */
  static async create(dir: string, wakeModelFile: string) {
    const [mel, embed, wake] = await Promise.all([
      ort.InferenceSession.create(path.join(dir, 'melspectrogram.onnx'), sessionOptions),
      ort.InferenceSession.create(path.join(dir, 'embedding_model.onnx'), sessionOptions),
      ort.InferenceSession.create(path.join(dir, wakeModelFile), sessionOptions),
    ])
    const detector = new WakeWordDetector(mel, embed, wake)
    await detector.reset()
    return detector
  }

  /** Clear all history (call when (re)starting to listen). */
  async reset() {
    this.raw = new Float32Array(0)
    this.mel = Array.from({ length: EMBED_WINDOW }, () => new Float32Array(MEL_BINS).fill(1))
    this.features = []
    // Like openWakeWord, prime the feature buffer with ~4 s of low-level noise.
    for (let i = 0; i < 50; i++) {
      const noise = new Float32Array(FRAME_SIZE)
      for (let j = 0; j < FRAME_SIZE; j++) noise[j] = Math.round(Math.random() * 2000 - 1000)
      await this.pushFrame(noise)
    }
    this.framesSinceReset = 0
  }

  /**
   * Process one 80 ms frame of audio in [-1, 1]. Returns the wake word score (0..1).
   */
  async process(frame: Float32Array): Promise<number> {
    if (frame.length !== FRAME_SIZE) throw new Error(`expected ${FRAME_SIZE} samples, got ${frame.length}`)
    // The models expect int16-range values (as float32).
    const pcm = new Float32Array(FRAME_SIZE)
    for (let i = 0; i < FRAME_SIZE; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i] * 32767)))
    await this.pushFrame(pcm)

    this.framesSinceReset++
    if (this.framesSinceReset <= WARMUP_FRAMES) return 0
    return this.predict()
  }

  private async pushFrame(pcm: Float32Array) {
    // Keep just enough raw audio for this frame plus mel context.
    const keep = FRAME_SIZE + MEL_CONTEXT
    const merged = new Float32Array(Math.min(this.raw.length + pcm.length, keep))
    const fromOld = merged.length - pcm.length
    merged.set(this.raw.subarray(this.raw.length - fromOld), 0)
    merged.set(pcm, fromOld)
    this.raw = merged

    // 1. Mel spectrogram of the newest audio (+ context), transformed like openWakeWord: x/10 + 2
    const melOut = await this.melModel.run({
      [this.melModel.inputNames[0]]: new ort.Tensor('float32', this.raw, [1, this.raw.length]),
    })
    const melData = melOut[this.melModel.outputNames[0]].data as Float32Array
    for (let f = 0; f + MEL_BINS <= melData.length; f += MEL_BINS) {
      const row = new Float32Array(MEL_BINS)
      for (let b = 0; b < MEL_BINS; b++) row[b] = melData[f + b] / 10 + 2
      this.mel.push(row)
    }
    if (this.mel.length > MAX_MEL_FRAMES) this.mel.splice(0, this.mel.length - MAX_MEL_FRAMES)

    // 2. One speech embedding from the latest 76 mel frames.
    const window = new Float32Array(EMBED_WINDOW * MEL_BINS)
    this.mel.slice(-EMBED_WINDOW).forEach((row, i) => window.set(row, i * MEL_BINS))
    const embedOut = await this.embedModel.run({
      [this.embedModel.inputNames[0]]: new ort.Tensor('float32', window, [1, EMBED_WINDOW, MEL_BINS, 1]),
    })
    const embedding = (embedOut[this.embedModel.outputNames[0]].data as Float32Array).slice(0, EMBED_SIZE)
    this.features.push(embedding)
    if (this.features.length > MAX_FEATURE_FRAMES) this.features.splice(0, this.features.length - MAX_FEATURE_FRAMES)
  }

  private async predict(): Promise<number> {
    const input = new Float32Array(WAKE_INPUT_FRAMES * EMBED_SIZE)
    this.features.slice(-WAKE_INPUT_FRAMES).forEach((row, i) => input.set(row, i * EMBED_SIZE))
    const out = await this.wakeModel.run({
      [this.wakeModel.inputNames[0]]: new ort.Tensor('float32', input, [1, WAKE_INPUT_FRAMES, EMBED_SIZE]),
    })
    return (out[this.wakeModel.outputNames[0]].data as Float32Array)[0]
  }
}
