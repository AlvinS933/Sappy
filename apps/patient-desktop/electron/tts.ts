import { app, ipcMain, type WebContents } from 'electron'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import aiConfig from '../ai.config.json'
import type { WorkerRequest, WorkerResponse } from './tts-worker'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dev: <app>/.models   Packaged: <resources>/models (see electron-builder.json5)
// A function, not a constant: APP_ROOT is set in main.ts after imports run.
const modelsDir = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(process.env.APP_ROOT, '.models')

let worker: Worker | null = null
let nextId = 1
const owners = new Map<number, WebContents>() // which window asked for each utterance

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(path.join(__dirname, 'tts-worker.js'), {
    workerData: { modelsDir: modelsDir(), config: aiConfig.tts },
  })
  worker.on('message', (msg: WorkerResponse) => {
    if (msg.type === 'ready') return
    if (msg.type === 'error' && msg.id === undefined) {
      console.error('[tts]', msg.message)
      return
    }
    const target = owners.get(msg.id!)
    if (!target || target.isDestroyed()) return
    if (msg.type === 'chunk') {
      target.send('tts:chunk', { id: msg.id, samples: msg.samples, sampleRate: msg.sampleRate })
    } else if (msg.type === 'error') {
      console.error('[tts]', msg.message)
    } else if (msg.type === 'done') {
      owners.delete(msg.id)
      target.send('tts:done', { id: msg.id })
    }
  })
  worker.on('error', (err) => console.error('[tts] worker crashed:', err))
  worker.on('exit', () => {
    worker = null
  })
  return worker
}

const send = (msg: WorkerRequest) => getWorker().postMessage(msg)

export function registerTtsHandlers() {
  // Start loading the model in the background right away so the first reply isn't delayed.
  getWorker()

  ipcMain.handle('tts:speak', (event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string')
    const id = nextId++
    owners.set(id, event.sender)
    send({ type: 'speak', id, text })
    return id
  })

  ipcMain.handle('tts:cancel', (_event, id: unknown) => {
    if (typeof id === 'number') send({ type: 'cancel', id })
  })

  app.on('before-quit', () => worker?.terminate())
}
