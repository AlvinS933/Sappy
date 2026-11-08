import { ipcMain, session, systemPreferences, type WebContents } from 'electron'
import aiConfig from '../ai.config.json'
import { modelsDir, startChild } from './child'
import type { VoiceWorkerRequest, VoiceWorkerResponse } from './voice-worker'

let listener: WebContents | null = null // the window receiving voice events
let wakeEnabled = false
let paused = false
let status: 'loading' | 'ready' | 'error' = 'loading'

export function registerVoiceHandlers() {
  // Load models in the background right away.
  const voice = startChild<VoiceWorkerRequest, VoiceWorkerResponse>({
    file: 'voice-worker.js',
    name: 'voice',
    init: { modelsDir: modelsDir(), config: { stt: aiConfig.stt, wakeWord: aiConfig.wakeWord } },
    onMessage: (msg) => {
      if (msg.type === 'ready') status = 'ready'
      if (msg.type === 'error') {
        console.error('[voice]', msg.message)
        if (status === 'loading') status = 'error'
      }
      if (listener && !listener.isDestroyed()) listener.send('voice:event', msg)
    },
    // Restore settings after a crash; the page gets a fresh 'ready' event.
    onRestart: () => {
      status = 'loading'
      voice.post({ type: 'wake-enabled', enabled: wakeEnabled })
      voice.post({ type: 'paused', paused })
      if (listener && !listener.isDestroyed()) listener.send('voice:event', { type: 'loading' })
    },
  })

  // Allow the page to use the microphone (audio only — never the camera).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    callback(permission === 'media' && mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio'))
  })

  // The page calls this on startup to receive events and learn whether models are loaded yet.
  ipcMain.handle('voice:connect', (event) => {
    listener = event.sender
    return { status, wakePhrase: aiConfig.wakeWord.phrase }
  })

  // macOS asks the user once; returns false if they declined.
  ipcMain.handle('voice:request-mic', async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  ipcMain.on('voice:frame', (event, samples: unknown) => {
    if (!(samples instanceof Float32Array)) return
    listener = event.sender
    voice.post({ type: 'frame', samples })
  })

  const control = (channel: string, toMsg: (arg: unknown) => VoiceWorkerRequest) =>
    ipcMain.on(channel, (event, arg) => {
      listener = event.sender
      voice.post(toMsg(arg))
    })
  control('voice:start', () => ({ type: 'start' }))
  control('voice:stop', () => ({ type: 'stop' }))
  control('voice:cancel', () => ({ type: 'cancel' }))
  control('voice:wake-enabled', (arg) => ({ type: 'wake-enabled', enabled: (wakeEnabled = arg === true) }))
  control('voice:paused', (arg) => ({ type: 'paused', paused: (paused = arg === true) }))
}
