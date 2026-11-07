/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, exposed in `preload.ts`
interface Window {
  ai: { chat(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<string> }
  tts: {
    /** Start speaking `text`. Resolves with an id used to match audio chunks. */
    speak(text: string): Promise<number>
    /** Stop generating audio for an utterance. */
    cancel(id: number): Promise<void>
    /** Called once per sentence of generated audio. Returns an unsubscribe function. */
    onChunk(cb: (chunk: { id: number; samples: Float32Array; sampleRate: number }) => void): () => void
    /** Called when an utterance has finished generating. Returns an unsubscribe function. */
    onDone(cb: (done: { id: number }) => void): () => void
  }
}

