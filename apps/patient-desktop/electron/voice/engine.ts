// Voice input state machine:
//
//   idle ──(wake word heard / mic button)──▶ recording ──(patient stops talking)──▶ transcribing ──▶ idle
//
// Feed it 80 ms frames of 16 kHz mono audio in [-1, 1] with `pushFrame`.
import { FRAME_SIZE, type WakeWordDetector } from './wakeword'
import type { SileroVad } from './vad'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

export type VoiceEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'wake'; score: number }
  | { type: 'transcript'; text: string }
  | { type: 'no-speech' }

export type EngineOptions = {
  wakeThreshold: number // 0..1, openWakeWord's default is 0.5
  speechThreshold: number // VAD probability that counts as speech
  endSilenceMs: number // stop after this much silence following speech
  noSpeechTimeoutMs: number // give up if nothing is said after activation
  maxRecordingMs: number
  wakePhrase?: string // removed from the start of transcripts ("Hey Jarvis, ...")
}

const FRAME_MS = (FRAME_SIZE / 16000) * 1000 // 80

export class VoiceEngine {
  private state: VoiceState = 'idle'
  private wakeEnabled = false
  private paused = false // e.g. while the app itself is speaking
  private busy = false // a frame is being processed
  private recording: Float32Array[] = []
  private recordedMs = 0
  private heardSpeech = false
  private silenceMs = 0
  private needsWakeReset = true // reset wake-word history before next use

  constructor(
    private wake: WakeWordDetector,
    private vad: SileroVad,
    private transcribe: (audio: Float32Array) => Promise<string>,
    private emit: (event: VoiceEvent) => void,
    private opts: EngineOptions,
  ) {}

  setWakeEnabled(enabled: boolean) {
    this.wakeEnabled = enabled
    if (enabled) this.needsWakeReset = true
  }

  /** Ignore the wake word (e.g. while text-to-speech is playing). */
  setPaused(paused: boolean) {
    this.paused = paused
    if (!paused) this.needsWakeReset = true // don't react to audio heard while paused
  }

  /** Start recording immediately (mic button). */
  startRecording() {
    if (this.state !== 'idle') return
    this.vad.reset()
    this.recording = []
    this.recordedMs = 0
    this.heardSpeech = false
    this.silenceMs = 0
    this.setState('recording')
  }

  /** Stop recording now and transcribe what was captured (mic button pressed again). */
  async stopRecording() {
    if (this.state === 'recording') await this.finishRecording()
  }

  /** Discard the current recording without transcribing. */
  cancel() {
    if (this.state === 'recording') {
      this.recording = []
      this.setState('idle')
    }
  }

  async pushFrame(frame: Float32Array) {
    if (frame.length !== FRAME_SIZE || this.busy) return // drop frames if we fall behind
    this.busy = true
    try {
      if (this.state === 'idle' && this.wakeEnabled && !this.paused) {
        if (this.needsWakeReset) {
          this.needsWakeReset = false
          await this.wake.reset()
        }
        const score = await this.wake.process(frame)
        if (score >= this.opts.wakeThreshold) {
          this.emit({ type: 'wake', score })
          this.startRecording()
        }
      } else if (this.state === 'recording') {
        await this.record(frame)
      }
    } finally {
      this.busy = false
    }
  }

  private async record(frame: Float32Array) {
    this.recording.push(frame)
    this.recordedMs += FRAME_MS

    const probs = await this.vad.process(frame)
    const chunkMs = FRAME_MS / Math.max(probs.length, 1)
    for (const p of probs) {
      if (p >= this.opts.speechThreshold) {
        this.heardSpeech = true
        this.silenceMs = 0
      } else {
        this.silenceMs += chunkMs
      }
    }

    if (this.heardSpeech && this.silenceMs >= this.opts.endSilenceMs) {
      await this.finishRecording()
    } else if (!this.heardSpeech && this.recordedMs >= this.opts.noSpeechTimeoutMs) {
      this.recording = []
      this.emit({ type: 'no-speech' })
      this.setState('idle')
    } else if (this.recordedMs >= this.opts.maxRecordingMs) {
      await this.finishRecording()
    }
  }

  private async finishRecording() {
    const frames = this.recording
    this.recording = []
    if (!this.heardSpeech) {
      this.emit({ type: 'no-speech' })
      this.setState('idle')
      return
    }
    this.setState('transcribing')
    try {
      const audio = new Float32Array(frames.length * FRAME_SIZE)
      frames.forEach((f, i) => audio.set(f, i * FRAME_SIZE))
      const text = cleanTranscript(await this.transcribe(audio), this.opts.wakePhrase)
      if (text) this.emit({ type: 'transcript', text })
      else this.emit({ type: 'no-speech' })
    } finally {
      this.needsWakeReset = true
      this.setState('idle')
    }
  }

  private setState(state: VoiceState) {
    this.state = state
    this.emit({ type: 'state', state })
  }
}

/** Remove Whisper artifacts like "[BLANK_AUDIO]" and a leading wake phrase. */
export function cleanTranscript(text: string, wakePhrase?: string): string {
  let t = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (wakePhrase) {
    const words = wakePhrase.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    t = t.replace(new RegExp(`^\\W*${words.join('\\W+')}\\W*`, 'i'), '')
  }
  // Capitalize the first letter after stripping.
  return t.charAt(0).toUpperCase() + t.slice(1)
}
