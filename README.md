pnpm dev -> launches both webapp and electron app
pnpm dev:patient -> launches only the electron app
pnpm dev:nurse -> launches only the webapp
brew install ollama -> local server that runs the model
pnpm ai:setup -> downloads qwen3.5:4b,Koroko-82M, Whisper base.en, openWakeWord, and Silero VAD v5.1.2
brew services start ollama -> start the local ollama server that runs the model
brew services stop ollama -> stop the local ollama server