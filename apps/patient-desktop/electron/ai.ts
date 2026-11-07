import { ipcMain } from 'electron'
import aiConfig from '../ai.config.json'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

const SYSTEM_PROMPT = `You are a helpful and human-friendly assistant for a hospital patient...`

// Only accept well-formed user/assistant messages from the renderer,
// so the page can't inject its own system prompt.
function sanitize(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) throw new Error('messages must be an array')
  return messages.map((m) => {
    if (
      !m ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string'
    ) {
      throw new Error('invalid message')
    }
    return { role: m.role, content: m.content }
  })
}

export function registerAiHandlers() {
  ipcMain.handle('ai:chat', async (_event, messages: unknown) => {
    const res = await fetch(`${aiConfig.ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: aiConfig.model,
        stream: false,
        think: false, // skip Qwen's "thinking" step: much faster replies
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...sanitize(messages)],
      }),
    })
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { message: { content: string } }
    return data.message.content
  })
}
