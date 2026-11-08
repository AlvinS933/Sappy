import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  server: { port: 5174, strictPort: true },
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`. The TTS worker is a separate file so it can run on its own thread.
        entry: ['electron/main.ts', 'electron/tts-worker.ts', 'electron/voice-worker.ts'],
        vite: {
          build: {
            // Load these from node_modules at runtime instead of bundling them
            // (they include a native ONNX runtime and large data files).
            rolldownOptions: { external: ['kokoro-js', '@huggingface/transformers', 'onnxruntime-node', '@supabase/supabase-js'] },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
})
