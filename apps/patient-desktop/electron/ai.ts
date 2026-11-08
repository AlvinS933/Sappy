import { ipcMain } from 'electron'
import aiConfig from '../ai.config.json'
import { dispatchAction, type PatientAction } from './actions'
import { runAgent, type ChatMessage } from './agent'

const MAX_MESSAGES = 20
const MAX_CHARS = 8_000

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  let recent = messages.slice(-MAX_MESSAGES)
  while (recent.length > 1 && recent.reduce((sum, m) => sum + m.content.length, 0) > MAX_CHARS) {
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
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new Error('invalid message')
    }
    return { role: m.role, content: m.content }
  })
}

/** What the page gets back: the spoken reply plus a short summary of any actions taken. */
export type ChatResponse = {
  reply: string
  actions: Pick<PatientAction, 'id' | 'type' | 'priority' | 'summary'>[]
}

export function registerAiHandlers() {
  ipcMain.handle('ai:chat', async (_event, messages: unknown): Promise<ChatResponse> => {
    const { reply, actions } = await runAgent(trimHistory(sanitize(messages)), {
      ollamaHost: aiConfig.ollamaHost,
      model: aiConfig.model,
      onAction: dispatchAction,
    })
    return { reply, actions: actions.map(({ id, type, priority, summary }) => ({ id, type, priority, summary })) }
  })
}
