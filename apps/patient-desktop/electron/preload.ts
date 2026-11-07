import { ipcRenderer, contextBridge } from 'electron'

// Only expose specific, narrow functions to the page — never the raw ipcRenderer.
contextBridge.exposeInMainWorld('ai', {
  chat: (messages: { role: string; content: string }[]) =>
    ipcRenderer.invoke('ai:chat', messages) as Promise<string>,
})
