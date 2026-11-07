import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron'

// Only expose specific, narrow functions to the page — never the raw ipcRenderer.
contextBridge.exposeInMainWorld('ai', {
  chat: (messages: { role: string; content: string }[]) =>
    ipcRenderer.invoke('ai:chat', messages) as Promise<string>,
})

type TtsChunk = { id: number; samples: Float32Array; sampleRate: number }

// Subscribe to a channel and return an unsubscribe function.
function listen<T>(channel: string, cb: (payload: T) => void) {
  const handler = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

contextBridge.exposeInMainWorld('tts', {
  speak: (text: string) => ipcRenderer.invoke('tts:speak', text) as Promise<number>,
  cancel: (id: number) => ipcRenderer.invoke('tts:cancel', id) as Promise<void>,
  onChunk: (cb: (chunk: TtsChunk) => void) => listen('tts:chunk', cb),
  onDone: (cb: (done: { id: number }) => void) => listen('tts:done', cb),
})
