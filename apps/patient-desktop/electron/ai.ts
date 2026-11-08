import { ipcMain } from 'electron'
import aiConfig from '../ai.config.json'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

const SYSTEM_PROMPT = `You are a helpful and human-friendly assistant for a hospital patient, respond only with two sentences maximum, remain short and concise.`
const MAX_MESSAGES = 20 
const MAX_CHARS = 8_000
function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  let recent = messages.slice(-MAX_MESSAGES)
  while (recent.length> 1 && recent.reduce((sum, m) => sum + m.content.length, 0) > MAX_CHARS) {
    recent = recent.slice(1)
  }
  while (recent.length > 1 && recent[0].role === 'assistant') recent = recent.slice(1)
  return recent
}
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
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...trimHistory(sanitize(messages))],
      }),
    })
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { message: { content: string } }
    return data.message.content
  })
}
