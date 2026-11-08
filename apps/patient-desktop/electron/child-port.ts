// Lets a background script run either as an Electron utility process (in the app)
// or as a Node worker thread (in tests), with the same messaging API.
//
// Each model runs in its own utility process because the native ONNX runtime
// can't be loaded by two threads of the same process — and so a crash in model
// code only takes down that process, not the whole app.
import { parentPort as threadPort } from 'node:worker_threads'

type Listener = (msg: unknown) => void

// Electron adds `process.parentPort` inside utility processes.
const electronPort = (process as unknown as {
  parentPort?: { on(event: 'message', cb: (e: { data: unknown }) => void): void; postMessage(msg: unknown): void }
}).parentPort

export function postToParent(msg: unknown, transfer: ArrayBuffer[] = []) {
  if (electronPort) electronPort.postMessage(msg)
  else threadPort?.postMessage(msg, transfer)
}

export function onParentMessage(cb: Listener) {
  if (electronPort) electronPort.on('message', (e) => cb(e.data))
  else threadPort?.on('message', cb)
}

/** Resolves with the first message from the parent, which carries the startup settings. */
export function waitForInit<T>(): Promise<T> {
  return new Promise((resolve) => {
    let done = false
    onParentMessage((msg) => {
      if (!done && (msg as { type?: string })?.type === 'init') {
        done = true
        resolve(msg as T)
      }
    })
  })
}
