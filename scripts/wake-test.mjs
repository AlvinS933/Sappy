#!/usr/bin/env node
// Scores the configured wake word model against synthetic voices.
//
//   pnpm wake:test                                   # uses wakeWord in ai.config.json
//   pnpm wake:test --model hey_sappy.onnx --phrase "Hey Sappy"
//
// Generates clips with macOS `say` voices and Kokoro voices:
//   - positives: the wake phrase (alone and followed by a request) → should trigger
//   - negatives: near-miss phrases and ordinary speech → should NOT trigger
// and reports the detection rate, false triggers and score distribution.
// macOS only (needs the `say` command). Run `pnpm ai:setup` first.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const appDir = fileURLToPath(new URL('../apps/patient-desktop/', import.meta.url))
const config = JSON.parse(readFileSync(path.join(appDir, 'ai.config.json'), 'utf8'))
const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: config.wakeWord.model },
    phrase: { type: 'string', default: config.wakeWord.phrase },
    threshold: { type: 'string', default: String(config.wakeWord.threshold) },
  },
})
const threshold = Number(args.threshold)
const phrase = args.phrase
const modelsDir = path.join(appDir, '.models', 'openwakeword')
if (!existsSync(path.join(modelsDir, args.model))) {
  console.error(`Model not found: ${path.join(modelsDir, args.model)}\nRun pnpm ai:setup, or copy your trained model there.`)
  process.exit(1)
}
if (process.platform !== 'darwin') {
  console.error('wake:test needs macOS (it uses the `say` command to generate voices).')
  process.exit(1)
}

const { WakeWordDetector, FRAME_SIZE } = await import(
  pathToFileURL(path.join(appDir, 'electron/voice/wakeword.ts')).href
)

// ---------- test phrases ----------
const positives = [phrase, `${phrase}, can I get some water?`, `${phrase}. I need my nurse, please.`]
const negatives = [
  // near misses
  'Hey happy', 'Happy birthday to you', 'That movie was so sappy', 'Hey Sammy, how are you?',
  'Hey Sophie', 'Hey, sorry about that', 'Say, Pappy, look at this', 'Hey Siri', 'Hey Jarvis',
  'Snappy service today', 'Hey, sad to see you go',
  // ordinary hospital conversation
  'Good morning, I am going to check your blood pressure now.',
  'Can you pass me the remote for the television?',
  'The doctor will be in to see you in about ten minutes.',
  'I would like some more water please.',
  'My daughter is coming to visit this afternoon.',
  'Please rate your pain on a scale from one to ten.',
  'Lunch today is chicken soup and a sandwich.',
]

// ---------- voices ----------
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy)/
const sayVoices = execFileSync('say', ['-v', '?'], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.match(/^(.+?)\s+(en_[A-Z]{2})\s+#/))
  .filter((m) => m && !NOVELTY.test(m[1]))
  .map((m) => m[1].trim())
const kokoroVoices = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable']

// ---------- audio generation (cached) ----------
const cacheDir = path.join(os.tmpdir(), 'wake-test-cache')
mkdirSync(cacheDir, { recursive: true })
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)

function readWav16(file) {
  const b = readFileSync(file)
  let o = 12
  while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4)
  const n = b.readUInt32LE(o + 4) / 2
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(o + 8 + i * 2) / 32768
  return out
}

function sayClip(text, voice, rate) {
  const file = path.join(cacheDir, `say_${slug(voice)}_${rate}_${slug(text)}.wav`)
  if (!existsSync(file)) {
    execFileSync('say', ['-v', voice, '-r', String(rate), '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', text])
  }
  return readWav16(file)
}

let kokoro = null
async function kokoroClip(text, voice, speed) {
  if (!kokoro) {
    const appRequire = createRequire(path.join(appDir, 'package.json'))
    const { env } = appRequire('@huggingface/transformers')
    const { KokoroTTS } = appRequire('kokoro-js')
    env.cacheDir = path.join(appDir, '.models')
    env.allowRemoteModels = false
    kokoro = await KokoroTTS.from_pretrained(config.tts.model, { dtype: config.tts.dtype, device: 'cpu' })
  }
  const audio = await kokoro.generate(text, { voice, speed })
  // Resample 24 kHz → 16 kHz (linear interpolation).
  const src = audio.audio
  const ratio = audio.sampling_rate / 16000
  const out = new Float32Array(Math.floor(src.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio
    const j = Math.floor(x)
    out[i] = src[j] + (src[Math.min(j + 1, src.length - 1)] - src[j]) * (x - j)
  }
  return out
}

// ---------- scoring ----------
const detector = await WakeWordDetector.create(modelsDir, args.model)
const quietNoise = (n) => Float32Array.from({ length: n }, () => (Math.random() - 0.5) * 0.002)

async function maxScore(audio) {
  await detector.reset()
  const padded = new Float32Array(8000 + audio.length + 16000)
  padded.set(quietNoise(8000), 0)
  padded.set(audio, 8000)
  padded.set(quietNoise(16000), 8000 + audio.length)
  let best = 0
  for (let i = 0; i + FRAME_SIZE <= padded.length; i += FRAME_SIZE) {
    best = Math.max(best, await detector.process(padded.subarray(i, i + FRAME_SIZE)))
  }
  return best
}

async function run(texts, label) {
  const results = []
  for (const text of texts) {
    for (const voice of sayVoices) for (const rate of [150, 200]) {
      results.push({ text, voice: `say:${voice}@${rate}`, score: await maxScore(sayClip(text, voice, rate)) })
    }
    for (const voice of kokoroVoices) for (const speed of [0.85, 1.1]) {
      results.push({ text, voice: `kokoro:${voice}@${speed}`, score: await maxScore(await kokoroClip(text, voice, speed)) })
    }
    process.stdout.write(`\r  ${label}: ${results.length} clips scored`)
  }
  process.stdout.write('\n')
  return results
}

console.log(`Wake word model: ${args.model}   phrase: "${phrase}"   threshold: ${threshold}`)
console.log(`Voices: ${sayVoices.length} macOS + ${kokoroVoices.length} Kokoro, 2 speeds each\n`)
const pos = await run(positives, 'positives')
// Skip negatives that *are* the phrase under test (e.g. "Hey Jarvis" when testing hey_jarvis).
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').trim()
const neg = await run(negatives.filter((t) => norm(t) !== norm(phrase)), 'negatives')

const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]
const hits = pos.filter((r) => r.score >= threshold)
const falses = neg.filter((r) => r.score >= threshold)

console.log(`\nDetected:        ${hits.length}/${pos.length} (${pct(hits.length, pos.length)})  ← higher is better`)
console.log(`False triggers:  ${falses.length}/${neg.length} (${pct(falses.length, neg.length)})  ← lower is better`)
console.log(`\nPositive scores: min ${quantile(pos.map((r) => r.score), 0).toFixed(2)}, 10th pct ${quantile(pos.map((r) => r.score), 0.1).toFixed(2)}, median ${quantile(pos.map((r) => r.score), 0.5).toFixed(2)}`)
console.log(`Negative scores: median ${quantile(neg.map((r) => r.score), 0.5).toFixed(2)}, 90th pct ${quantile(neg.map((r) => r.score), 0.9).toFixed(2)}, max ${quantile(neg.map((r) => r.score), 1).toFixed(2)}`)

console.log('\nAt other thresholds:')
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  const d = pos.filter((r) => r.score >= t).length
  const f = neg.filter((r) => r.score >= t).length
  console.log(`  ${t.toFixed(1)}  detected ${pct(d, pos.length).padStart(6)}   false triggers ${pct(f, neg.length).padStart(6)}`)
}

if (falses.length) {
  console.log('\nFalse triggers (by phrase):')
  const byText = Map.groupBy(falses, (r) => r.text)
  for (const [text, rs] of byText) console.log(`  ${rs.length}× "${text}"  (max ${Math.max(...rs.map((r) => r.score)).toFixed(2)})`)
}
const misses = pos.filter((r) => r.score < threshold)
if (misses.length) {
  console.log('\nMissed (by voice):')
  const byVoice = Map.groupBy(misses, (r) => r.voice.split('@')[0])
  for (const [voice, rs] of [...byVoice].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    console.log(`  ${rs.length}× ${voice}`)
  }
}
