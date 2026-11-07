#!/usr/bin/env node
// Downloads the local AI models used by the patient app:
//   - the chat model (via Ollama)
//   - the text-to-speech voice model (Kokoro, into apps/patient-desktop/.models)
// Usage: pnpm ai:setup   (run `pnpm install` first)
// Override the chat model with PATIENT_AI_MODEL=<name> pnpm ai:setup

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const configPath = fileURLToPath(new URL('../apps/patient-desktop/ai.config.json', import.meta.url))
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const model = process.env.PATIENT_AI_MODEL || config.model
const host = process.env.OLLAMA_HOST_URL || config.ollamaHost

const log = (msg) => console.log(`[ai:setup] ${msg}`)
const fail = (msg) => {
  console.error(`\n[ai:setup] ${msg}\n`)
  process.exit(1)
}

// 1. Is Ollama installed?
const version = spawnSync('ollama', ['--version'], { encoding: 'utf8' })
if (version.error) {
  const install = {
    darwin: 'brew install ollama   (or download the app from https://ollama.com/download)',
    linux: 'curl -fsSL https://ollama.com/install.sh | sh',
    win32: 'Download the installer from https://ollama.com/download',
  }[process.platform] ?? 'See https://ollama.com/download'
  fail(`Ollama is not installed. Install it first:\n\n    ${install}\n\nThen run: pnpm ai:setup`)
}
log(version.stdout.trim())

// 2. Is the Ollama server running? Start it temporarily if not.
async function isUp() {
  try {
    const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

let tempServer = null
if (!(await isUp())) {
  log('Ollama server is not running, starting it temporarily...')
  tempServer = spawn('ollama', ['serve'], { stdio: 'ignore' })
  for (let i = 0; i < 40 && !(await isUp()); i++) await new Promise((r) => setTimeout(r, 250))
  if (!(await isUp())) fail('Could not start the Ollama server. Try running `ollama serve` yourself.')
}
const stopTempServer = () => tempServer?.kill()
process.on('exit', stopTempServer)

// 3. Pull the model (skips the download if it's already up to date).
log(`Pulling ${model} ...`)
const pull = spawnSync('ollama', ['pull', model], { stdio: 'inherit' })
if (pull.status !== 0) {
  // Offline or registry hiccup: fine as long as we already have a copy.
  const tags = await fetch(`${host}/api/tags`).then((r) => r.json()).catch(() => ({ models: [] }))
  if (!tags.models?.some((m) => m.name === model)) fail(`Failed to pull ${model}.`)
  log(`Could not check for updates, using the copy of ${model} already downloaded.`)
}

// 4. Smoke test.
log('Testing the model...')
try {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const data = await res.json()
  log(`Model replied: "${data.message.content.trim()}"`)
} catch (err) {
  fail(`Model downloaded but the test request failed: ${err.message}`)
}

log(`${model} is ready.`)

// 5. Text-to-speech model (Kokoro). Saved into apps/patient-desktop/.models,
//    which the app reads from at runtime (it never downloads models itself).
const appDir = fileURLToPath(new URL('../apps/patient-desktop/', import.meta.url))
const modelsDir = path.join(appDir, '.models')
const tts = config.tts
log(`Downloading voice model ${tts.model} (${tts.dtype}) ...`)
try {
  const appRequire = createRequire(path.join(appDir, 'package.json'))
  const { env } = appRequire('@huggingface/transformers')
  const { KokoroTTS } = appRequire('kokoro-js')
  env.cacheDir = modelsDir
  env.allowRemoteModels = true

  const seen = new Set()
  const kokoro = await KokoroTTS.from_pretrained(tts.model, {
    dtype: tts.dtype,
    device: 'cpu',
    progress_callback: (p) => {
      if (p.status === 'done' && !seen.has(p.file)) {
        seen.add(p.file)
        log(`  ✓ ${p.file}`)
      }
    },
  })
  const started = performance.now()
  const audio = await kokoro.generate('Hello, I am ready.', { voice: tts.voice })
  const secs = (audio.audio.length / audio.sampling_rate).toFixed(1)
  log(`Voice test: generated ${secs}s of audio in ${((performance.now() - started) / 1000).toFixed(1)}s`)
} catch (err) {
  fail(`Failed to set up the voice model: ${err.message}`)
}

log('Done. All local AI models are ready.')
if (tempServer) {
  log('Note: Ollama was started only for this setup. Before `pnpm dev:patient`, run')
  log('      `ollama serve`, open the Ollama app, or `brew services start ollama`.')
}
