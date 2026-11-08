import { ipcMain, type WebContents } from 'electron'
import aiConfig from '../ai.config.json'
import { modelsDir, startChild } from './child'
import type { WorkerRequest, WorkerResponse } from './tts-worker'

let nextId = 1
const owners = new Map<number, WebContents>() // which window asked for each utterance

function finish(id: number) {
  const target = owners.get(id)
  owners.delete(id)
  if (target && !target.isDestroyed()) target.send('tts:done', { id })
}

export function registerTtsHandlers() {
  // Start loading the model right away so the first reply isn't delayed.
  const tts = startChild<WorkerRequest, WorkerResponse>({
    file: 'tts-worker.js',
    name: 'tts',
    init: { modelsDir: modelsDir(), config: aiConfig.tts },
    onMessage: (msg) => {
      if (msg.type === 'ready') return
      if (msg.type === 'error') {
        console.error('[tts]', msg.message)
        return
      }
      if (msg.type === 'done') return finish(msg.id)
      const target = owners.get(msg.id)
      if (target && !target.isDestroyed()) {
        target.send('tts:chunk', { id: msg.id, text: msg.text, samples: msg.samples, sampleRate: msg.sampleRate })
      }
    },
    // Anything in progress was lost in the crash; let the page know it's over.
    onRestart: () => [...owners.keys()].forEach(finish),
  })

  ipcMain.handle('tts:speak', (event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string')
    const id = nextId++
    owners.set(id, event.sender)
    tts.post({ type: 'speak', id, text })
    return id
  })

  ipcMain.handle('tts:cancel', (_event, id: unknown) => {
    if (typeof id === 'number') tts.post({ type: 'cancel', id })
  })
}
