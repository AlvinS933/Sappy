import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { registerAiHandlers } from './ai'
import { registerTtsHandlers } from './tts'
import { registerVoiceHandlers } from './voice'
import { loadPatientAssignment } from './patient'
import { closeCompanionWindow, createCompanionWindow, registerCompanionHandlers } from './companion-window'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
const PRELOAD = path.join(__dirname, 'preload.mjs')

/** Load the renderer; `hash` picks the view (e.g. "companion" for the overlay widget). */
function loadRenderer(target: BrowserWindow, hash?: string) {
  if (VITE_DEV_SERVER_URL) {
    target.loadURL(hash ? `${VITE_DEV_SERVER_URL}#${hash}` : VITE_DEV_SERVER_URL)
  } else {
    target.loadFile(path.join(RENDERER_DIST, 'index.html'), hash ? { hash } : undefined)
  }
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: PRELOAD,
    },
  })
  loadRenderer(win)
  // The companion overlay belongs to the chat window: close it too.
  win.on('closed', () => {
    win = null
    closeCompanionWindow()
  })

  createCompanionWindow({ preload: PRELOAD, load: (widget) => loadRenderer(widget, 'companion') })
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (!win) {
    createWindow()
  }
})

app.whenReady().then(() => {
  loadPatientAssignment()
  registerAiHandlers()
  registerTtsHandlers()
  registerVoiceHandlers()
  registerCompanionHandlers()
  createWindow()
})
