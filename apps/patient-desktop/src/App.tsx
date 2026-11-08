import { useEffect, useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/electron-vite.animate.svg'
import './App.css'
import { useSpeech } from './useSpeech'
import { playChime, useVoiceInput } from './useVoiceInput'

type Msg = { role: 'user' | 'assistant'; content: string }

function App() {
  const [count, setCount] = useState(0)
  const [input, setInput] = useState<string>('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [voiceOn, setVoiceOn] = useState(true)
  const { speak, stop, speaking } = useSpeech()
  const voice = useVoiceInput({
    onTranscript: (text) => void send(text),
    onWake: () => {
      stop()
      playChime()
    },
  })

  // Don't listen for the wake word while the app is thinking or talking (it could hear itself).
  const { setPaused } = voice
  useEffect(() => setPaused(speaking || loading), [speaking, loading, setPaused])

  // `spoken` is text from speech-to-text; otherwise send what's typed in the box.
  async function send(spoken?: string) {
    const text = (spoken ?? input).trim()
    if (!text || loading) return
    stop() // don't keep reading the previous reply over the new one
    const next = [...messages, {role: 'user' as const, content: text}]
    setMessages(next)
    if (spoken === undefined) setInput('')
    setLoading(true)
    let reply: string
    try {
      reply = await window.ai.chat(next)
    } catch (err) {
      console.error('AI chat failed:', err)
      reply = "Sorry, I can't respond right now. Please press the call button if you need a nurse."
    }
    setMessages([...next, { role: 'assistant', content: reply }])
    setLoading(false)
    if (voiceOn) void speak(reply)
  }
  return (
    <>
      <div>
        <a href="https://electron-vite.github.io" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
        {messages.map((m, i) => (
          <p key={i}>
            <b>{m.role === 'user' ? 'You' : 'Assistant'}:</b> {m.content}
          </p>
        ))}
        {loading && <p>Thinking…</p>}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void send()}
          placeholder="Talk to AI..." 
          disabled={loading}
        />
        <div>
          <label>
            <input
              type="checkbox"
              checked={voiceOn}
              onChange={(e) => {
                setVoiceOn(e.target.checked)
                if (!e.target.checked) stop()
              }}
            />{' '}
            Read replies aloud
          </label>
          {speaking && <button onClick={stop}>Stop speaking</button>}
        </div>
        <div>
          <button
            onClick={() => {
              stop()
              void voice.toggleRecording()
            }}
            disabled={loading || (voice.status !== 'idle' && voice.status !== 'recording')}
          >
            {voice.status === 'recording' ? '⏹ Done talking' : '🎤 Talk'}
          </button>{' '}
          <label>
            <input
              type="checkbox"
              checked={voice.wakeEnabled}
              disabled={voice.status === 'loading' || voice.status === 'error'}
              onChange={(e) => void voice.setWakeEnabled(e.target.checked)}
            />{' '}
            Say “{voice.wakePhrase || '…'}” to talk
          </label>
          <p>
            {voice.status === 'loading' && 'Loading voice models…'}
            {voice.status === 'recording' && 'Listening…'}
            {voice.status === 'transcribing' && 'Understanding…'}
            {voice.status === 'error' && 'Voice input is unavailable.'}
            {voice.micError}
          </p>
        </div>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </>
  )
}

export default App
