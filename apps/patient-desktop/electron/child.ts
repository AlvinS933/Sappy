// Starts a background script (built into dist-electron/) as an Electron utility
// process, and restarts it if it crashes.
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Dev: <app>/.models   Packaged: <resources>/models (see electron-builder.json5) */
export const modelsDir = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(process.env.APP_ROOT, '.models')

type Options<Res> = {
  /** File name in dist-electron/, e.g. 'tts-worker.js' */
  file: string
  name: string
  /** Sent as the first message (`{ type: 'init', ...init }`). */
  init: Record<string, unknown>
  onMessage: (msg: Res) => void
  /** Called after the process crashed and was restarted (state inside it was lost). */
  onRestart?: () => void
}

export function startChild<Req, Res>({ file, name, init, onMessage, onRestart }: Options<Res>) {
  let child: UtilityProcess | null = null
  let quitting = false
  let restarts = 0

  const spawn = () => {
    child = utilityProcess.fork(path.join(__dirname, file), [], { serviceName: name, stdio: 'inherit' })
    child.postMessage({ type: 'init', ...init })
    child.on('message', (msg: Res) => onMessage(msg))
    child.on('exit', (code) => {
      child = null
      if (quitting) return
      console.error(`[${name}] process exited (code ${code})`)
      // Restart, but give up if it keeps crashing.
      if (restarts++ < 3) {
        spawn()
        onRestart?.()
      }
    })
  }

  app.on('before-quit', () => {
    quitting = true
    child?.kill()
  })

  spawn()
  return {
    post(msg: Req) {
      child?.postMessage(msg)
    },
  }
}
