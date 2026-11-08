// Voice activity detection with Silero VAD v5 (MIT license).
// Port of silero_vad's OnnxWrapper: 512-sample chunks @ 16 kHz with 64 samples
// of context from the previous chunk and a recurrent state.
import * as ort from 'onnxruntime-node'

const CHUNK = 512 // 32 ms @ 16 kHz
const CONTEXT = 64
const SAMPLE_RATE = 16000

export class SileroVad {
  private state = new Float32Array(2 * 1 * 128)
  private context = new Float32Array(CONTEXT)
  private pending = new Float32Array(0)
  private session: ort.InferenceSession

  private constructor(session: ort.InferenceSession) {
    this.session = session
  }

  static async create(modelPath: string) {
    const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1 })
    return new SileroVad(session)
  }

  reset() {
    this.state = new Float32Array(2 * 1 * 128)
    this.context = new Float32Array(CONTEXT)
    this.pending = new Float32Array(0)
  }

  /**
   * Feed audio in [-1, 1] of any length. Returns one speech probability (0..1)
   * per complete 32 ms chunk; leftover samples are kept for the next call.
   */
  async process(audio: Float32Array): Promise<number[]> {
    const buf = new Float32Array(this.pending.length + audio.length)
    buf.set(this.pending, 0)
    buf.set(audio, this.pending.length)

    const probs: number[] = []
    let offset = 0
    for (; offset + CHUNK <= buf.length; offset += CHUNK) {
      const input = new Float32Array(CONTEXT + CHUNK)
      input.set(this.context, 0)
      input.set(buf.subarray(offset, offset + CHUNK), CONTEXT)

      const out = await this.session.run({
        input: new ort.Tensor('float32', input, [1, CONTEXT + CHUNK]),
        state: new ort.Tensor('float32', this.state, [2, 1, 128]),
        sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
      })
      this.state = new Float32Array(out.stateN.data as Float32Array)
      this.context = input.slice(-CONTEXT)
      probs.push((out.output.data as Float32Array)[0])
    }
    this.pending = buf.slice(offset)
    return probs
  }
}
