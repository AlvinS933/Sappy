// The bedside assistant: a chat model that can decide to take actions (tools) for the patient.
//
//   patient message ─▶ safety check (keywords, instant) ─▶ model ─▶ tool calls? ─▶ run tools ─▶ model ─▶ reply
//
// Kept free of Electron imports so it can be tested directly with Node.
import { createAction, type PatientAction, type Priority } from './actions.ts'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export type AgentOptions = {
  ollamaHost: string
  model: string
  /** Called for every action as soon as it's decided (log it, send it to staff, …). */
  onAction: (action: PatientAction) => void
  timeoutMs?: number
}

export type AgentResult = { reply: string; actions: PatientAction[] }

export const SYSTEM_PROMPT = `You are a friendly bedside assistant for a patient in a hospital room. The patient talks to you by voice or text, and your replies are read aloud.

HOW TO TALK
- Reply in one to three short sentences of plain spoken language. No lists, markdown, headings, or emoji.
- Be warm, calm, and patient. Use simple words. Patients may be tired, in pain, elderly, or anxious.
- If you are not sure what the patient means, ask one short question.

WHAT YOU ARE
- You are an AI assistant. You are not a nurse or doctor and not part of the care team. Say so if asked.
- Do not diagnose, interpret symptoms or test results, or give advice about medications, doses, or treatment. Say that the nurse or doctor can answer, and offer to let the nurse know.
- Never make up information about the patient's care, schedule, medications, or results. If you don't know, say so.
- You cannot bring things or come to the room yourself. Staff do that. Use your tools to ask them.

TOOLS
- request_item: the patient wants something brought, like water, food, a blanket, a pillow, or toiletries.
- call_nurse: the patient needs a person. For example help to the bathroom or out of bed, pain or discomfort, a beeping machine or IV, a medication question, or simply wanting to talk to the nurse.
- emergency_alert: use immediately for a possible emergency. For example chest pain or pressure, trouble breathing, choking, a fall, stroke signs such as face drooping, arm weakness, or slurred speech, heavy bleeding, a seizure, fainting, sudden severe pain, or talk of harming themselves.
- Only use a tool when the patient needs it. Do not use tools for small talk or general questions.
- For everyday conversation, like TV, the weather, family, or how their day is going, just chat and help as best you can yourself. For example, if asked what to watch, suggest a kind of show, like a comedy or a nature documentary. Only offer to involve staff when it's about the patient's care, comfort, or safety.
- If you offered to contact the nurse and the patient says yes, call the tool.
- Never say you have notified someone unless the tool call succeeded.
- After using a tool, briefly tell the patient what you did, for example "I've asked your nurse to bring you some water."
- Do not promise exactly what or when. Staff decide, since some patients can't eat or drink before a procedure.

EMERGENCIES
- After emergency_alert, tell the patient that help is on the way and to press their call button now if they can. Keep them calm. Do not give medical instructions.`

// ---------- tools ----------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'request_item',
      description: 'Ask staff to bring the patient an item, such as water, food, a blanket, a pillow, or toiletries.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'What the patient wants, in a few words, e.g. "water" or "extra blanket".' },
          category: { type: 'string', enum: ['drink', 'food', 'comfort', 'hygiene', 'other'] },
          details: { type: 'string', description: 'Anything else the patient said about it, e.g. "with ice". Optional.' },
        },
        required: ['item', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_nurse',
      description: 'Ask the nurse to come to the room for something that is not an emergency.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short reason for staff, e.g. "help getting to the bathroom".' },
          priority: {
            type: 'string',
            enum: ['routine', 'soon', 'urgent'],
            description: 'routine = when convenient; soon = within a few minutes (e.g. bathroom, pain); urgent = needs attention now but not life-threatening.',
          },
        },
        required: ['reason', 'priority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'emergency_alert',
      description: 'Immediately alert staff to a possible medical emergency.',
      parameters: {
        type: 'object',
        properties: {
          symptoms: { type: 'string', description: 'What the patient described, in their words where possible.' },
        },
        required: ['symptoms'],
      },
    },
  },
]

// ---------- safety net ----------
// Catches clear, first-person, happening-now emergencies without waiting for (or relying on)
// the model. Deliberately narrow: "My mom had a heart attack last year" must NOT page staff —
// too many false alarms and staff start ignoring them. The model judges less clear-cut cases.
const PAST = /\b(yesterday|last (night|week|month|year)|ago|before i came|years?|months?)\b/i
const EMERGENCY_PATTERNS: RegExp[] = [
  /\bmy chest\b.*\b(hurts?|hurting|pain|tight|pressure|heavy)\b/i,
  /\bi(?: have|'ve got|'m having| am having)? (?:bad |sudden |really bad |severe )?chest (?:pain|pressure|tightness)\b/i,
  /\b(?:i'?m|i am|i think i'?m) having a (?:heart attack|stroke|seizure)\b/i,
  /\bi (?:can'?t|cannot|can not) breathe\b/i,
  /\bi'?m (?:choking|struggling to breathe|having trouble breathing|short of breath)\b/i,
  /\bi(?: just|'ve just|'ve| have)? (?:fell|fallen|fainted|passed out)\b/i,
  /\bi(?:'m| am| feel like i'?m| think i'?m)(?: going to| about to| gonna)? (?:pass out|faint|passing out|fainting)\b/i,
  /\b(?:i'?m bleeding (?:a lot|heavily|badly|everywhere)|won'?t stop bleeding)\b/i,
  /\bmy (?:face|mouth) (?:is )?(?:drooping|numb)\b/i,
  // Always alert on self-harm language, whatever the tense.
  /\b(?:kill myself|want to die|end my life|hurt myself|suicid\w*)\b/i,
]
const ALWAYS = EMERGENCY_PATTERNS.length - 1 // index of the self-harm pattern

export function detectEmergency(text: string): boolean {
  return EMERGENCY_PATTERNS.some((p, i) => p.test(text) && (i === ALWAYS || !PAST.test(text)))
}

// ---------- agent loop ----------

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
  tool_name?: string
}

const MAX_TOOL_ROUNDS = 3
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const PRIORITIES: Priority[] = ['routine', 'soon', 'urgent']

export async function runAgent(history: ChatMessage[], opts: AgentOptions): Promise<AgentResult> {
  const patientMessage = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
  const actions: PatientAction[] = []
  const record = (a: Omit<PatientAction, 'id' | 'createdAt' | 'patientMessage'>) => {
    const action = createAction({ ...a, patientMessage })
    actions.push(action)
    opts.onAction(action)
    return action
  }

  const messages: OllamaMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history]

  // 1. Safety net first: alert staff instantly, then tell the model it's done.
  let emergencySent = false
  if (detectEmergency(patientMessage)) {
    record({ type: 'emergency', priority: 'emergency', summary: patientMessage, details: { symptoms: patientMessage }, source: 'safety_check' })
    emergencySent = true
    messages.push({
      role: 'system',
      content: 'An emergency alert for this message has ALREADY been sent to the nursing staff. Do not call emergency_alert again. Tell the patient help is on the way and to press their call button now if they can.',
    })
  }

  // 2. Let the model reply, running any tools it asks for.
  const runTool = (name: string, args: Record<string, unknown>): string => {
    switch (name) {
      case 'request_item': {
        const item = str(args.item) || 'an item'
        record({
          type: 'item_request',
          priority: 'routine',
          summary: item,
          details: { item, category: str(args.category) || 'other', ...(str(args.details) && { details: str(args.details) }) },
          source: 'assistant',
        })
        return `Request sent to staff: ${item}. Staff will bring it if it's okay for this patient.`
      }
      case 'call_nurse': {
        const reason = str(args.reason) || 'patient asked for the nurse'
        const priority = PRIORITIES.includes(args.priority as Priority) ? (args.priority as Priority) : 'soon'
        record({ type: 'nurse_call', priority, summary: reason, details: { reason }, source: 'assistant' })
        return `The nurse has been notified (${priority}): ${reason}.`
      }
      case 'emergency_alert': {
        if (emergencySent) return 'An emergency alert was already sent for this. Staff are on the way.'
        const symptoms = str(args.symptoms) || patientMessage
        record({ type: 'emergency', priority: 'emergency', summary: symptoms, details: { symptoms }, source: 'assistant' })
        emergencySent = true
        return 'Emergency alert sent. Staff are on the way.'
      }
      default:
        return `Unknown tool "${name}". Nothing was sent.`
    }
  }

  let reply = ''
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await fetch(`${opts.ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          stream: false,
          think: false, // skip Qwen's "thinking" step: much faster replies
          messages,
          // After the last allowed round, ask for a plain reply only.
          ...(round < MAX_TOOL_ROUNDS && { tools: TOOLS }),
          options: { num_ctx: 8192 },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      })
      if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
      const { message } = (await res.json()) as { message: OllamaMessage }

      if (!message.tool_calls?.length) {
        reply = message.content.trim()
        break
      }
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls })
      for (const call of message.tool_calls) {
        const result = runTool(call.function.name, call.function.arguments ?? {})
        messages.push({ role: 'tool', tool_name: call.function.name, content: result })
      }
    }
  } catch (err) {
    // The model failed, but any actions already recorded have been sent.
    if (!actions.length) throw err
    console.error('[agent] model failed after taking actions:', err)
  }

  return { reply: reply || fallbackReply(actions), actions }
}

/** Used if the model gives no usable reply, so the patient always hears something accurate. */
function fallbackReply(actions: PatientAction[]): string {
  if (actions.some((a) => a.type === 'emergency')) {
    return "I've alerted the nursing staff and help is on the way. Please press your call button now if you can."
  }
  if (actions.length) return "I've let the staff know. Someone will be with you soon."
  return "Sorry, I didn't catch that. Could you say it again?"
}
