// The bedside assistant: a chat model that can decide to take actions (tools) for the patient.
//
//   patient message ─▶ safety check (keywords, instant) ─▶ model ─▶ tool calls? ─▶ run tools ─▶ model ─▶ reply
//
// Kept free of Electron imports so it can be tested directly with Node.
import {
  createAction,
  EMERGENCY_KINDS,
  ITEM_CATEGORIES,
  NURSE_REASONS,
  type EmergencyKind,
  type ItemCategory,
  type NurseReason,
  type PatientAction,
} from './actions.ts'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export type AgentOptions = {
  ollamaHost: string
  model: string
  /** Pseudonymous Patient.id this device is assigned to (null if not configured). */
  patientId: string | null
  /** Called for every action as soon as it's decided: send it to staff. Resolves true if delivered. */
  onAction: (action: PatientAction) => Promise<boolean>
  timeoutMs?: number
}

export type AgentResult = { reply: string; actions: (PatientAction & { delivered: boolean })[] }

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
- call_nurse: the patient needs a person. For example help to the bathroom or out of bed, pain or discomfort, a beeping machine or IV, a medication question, or simply wanting to talk to the nurse. Anything about the toilet or bathroom is reason "bathroom", even if they also need help walking. Help sitting up, moving in bed, or getting up is reason "mobility". You can't move the patient yourself, so always call the nurse for these.
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
          category: { type: 'string', enum: [...ITEM_CATEGORIES] },
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
          reason: {
            type: 'string',
            enum: [...NURSE_REASONS],
            description:
              'bathroom = help to the bathroom; pain = pain or discomfort; mobility = help moving or getting out of bed; ' +
              'equipment = a beeping machine, IV or device problem; medication = a question about medicines; ' +
              'comfort = repositioning or feeling unwell; talk = wants to talk to the nurse; other = anything else.',
          },
          priority: {
            type: 'string',
            enum: ['routine', 'soon', 'urgent'],
            description: 'routine = when convenient; soon = within a few minutes (e.g. bathroom, pain); urgent = needs attention now but not life-threatening.',
          },
          details: { type: 'string', description: 'Short note in your own words. Optional.' },
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
          kind: {
            type: 'string',
            enum: [...EMERGENCY_KINDS],
            description: 'The closest match to what the patient described.',
          },
          details: { type: 'string', description: 'Short note in your own words. Optional.' },
        },
        required: ['kind'],
      },
    },
  },
]

// ---------- safety net ----------
// Catches clear, first-person, happening-now emergencies without waiting for (or relying on)
// the model. Deliberately narrow: "My mom had a heart attack last year" must NOT page staff —
// too many false alarms and staff start ignoring them. The model judges less clear-cut cases.
const PAST = /\b(yesterday|last (night|week|month|year)|ago|before i came|years?|months?)\b/i
const EMERGENCY_PATTERNS: [RegExp, EmergencyKind][] = [
  [/\bmy chest\b.*\b(hurts?|hurting|pain|tight|pressure|heavy)\b/i, 'chest_pain'],
  [/\bi(?: have|'ve got|'m having| am having)? (?:bad |sudden |really bad |severe )?chest (?:pain|pressure|tightness)\b/i, 'chest_pain'],
  [/\b(?:i'?m|i am|i think i'?m) having a heart attack\b/i, 'chest_pain'],
  [/\b(?:i'?m|i am|i think i'?m) having a stroke\b/i, 'stroke_signs'],
  [/\bmy (?:face|mouth) (?:is )?(?:drooping|numb)\b/i, 'stroke_signs'],
  [/\b(?:i'?m|i am|i think i'?m) having a seizure\b/i, 'seizure'],
  [/\bi (?:can'?t|cannot|can not) breathe\b/i, 'breathing'],
  [/\bi'?m (?:choking|struggling to breathe|having trouble breathing|short of breath)\b/i, 'breathing'],
  [/\bi(?: just|'ve just|'ve| have)? (?:fell|fallen)\b/i, 'fall'],
  [/\bi(?: just|'ve just|'ve| have)? (?:fainted|passed out)\b/i, 'fainting'],
  [/\bi(?:'m| am| feel like i'?m| think i'?m)(?: going to| about to| gonna)? (?:pass out|faint|passing out|fainting)\b/i, 'fainting'],
  [/\b(?:i'?m bleeding (?:a lot|heavily|badly|everywhere)|won'?t stop bleeding)\b/i, 'bleeding'],
  // Always alert on self-harm language, whatever the tense.
  [/\b(?:kill myself|want to die|end my life|hurt myself|suicid\w*)\b/i, 'self_harm'],
]

/** The kind of emergency described, or null. Past events ("last year") don't count, except self-harm. */
export function detectEmergency(text: string): EmergencyKind | null {
  for (const [pattern, kind] of EMERGENCY_PATTERNS) {
    if (pattern.test(text) && (kind === 'self_harm' || !PAST.test(text))) return kind
  }
  return null
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
const BATHROOM = /\b(bathroom|toilet|restroom|commode|bedpan|pee|poop|wee)\b/i

/** Accept the model's choice only if it's one of the allowed values. */
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

export async function runAgent(history: ChatMessage[], opts: AgentOptions): Promise<AgentResult> {
  const patientMessage = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
  const actions: (PatientAction & { delivered: boolean })[] = []
  const record = async (spec: Parameters<typeof createAction>[0], source: PatientAction['source'], detail?: string) => {
    const action = createAction(spec, { patientId: opts.patientId, source, patientMessage, detail })
    const delivered = await opts.onAction(action)
    actions.push({ ...action, delivered })
    return { action, delivered }
  }
  // Told to the model when an alert couldn't be saved, so it never claims staff were notified.
  const NOT_DELIVERED = 'FAILED: the request could not be sent to staff. Tell the patient you could not reach the nurses and ask them to press their call button.'

  const messages: OllamaMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history]

  // 1. Safety net first: alert staff instantly, then tell the model it's done.
  let emergencySent = false
  const detected = detectEmergency(patientMessage)
  if (detected) {
    const { delivered } = await record({ type: 'emergency', category: detected }, 'safety_check')
    emergencySent = true
    messages.push({
      role: 'system',
      content: delivered
        ? 'An emergency alert for this message has ALREADY been sent to the nursing staff. Do not call emergency_alert again. Tell the patient help is on the way and to press their call button now if they can.'
        : 'An emergency alert for this message COULD NOT be sent to staff. Do not call emergency_alert. Tell the patient to press their call button right now, and to call out for help if they can.',
    })
  }

  // 2. Let the model reply, running any tools it asks for.
  const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'request_item': {
        const category = oneOf<ItemCategory>(args.category, ITEM_CATEGORIES, 'other')
        const { action, delivered } = await record({ type: 'item_request', category, item: str(args.item) }, 'assistant', str(args.details) || str(args.item))
        return delivered ? `Request sent to staff: ${action.label}. Staff will bring it if it's okay for this patient.` : NOT_DELIVERED
      }
      case 'call_nurse': {
        let category = oneOf<NurseReason>(args.reason, NURSE_REASONS, 'other')
        // The small model sometimes files bathroom help under "mobility"; staff need to know it's the bathroom.
        if (BATHROOM.test(patientMessage)) category = 'bathroom'
        const priority = oneOf(args.priority, ['routine', 'soon', 'urgent'] as const, 'soon')
        const { action, delivered } = await record({ type: 'nurse_call', category, priority }, 'assistant', str(args.details))
        return delivered ? `The nurse has been notified (${priority}): ${action.label}.` : NOT_DELIVERED
      }
      case 'emergency_alert': {
        if (emergencySent) return 'An emergency alert was already sent for this. Staff are on the way.'
        const category = oneOf<EmergencyKind>(args.kind, EMERGENCY_KINDS, 'other')
        const { delivered } = await record({ type: 'emergency', category }, 'assistant', str(args.details))
        emergencySent = true
        return delivered ? 'Emergency alert sent. Staff are on the way.' : NOT_DELIVERED
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
        const result = await runTool(call.function.name, call.function.arguments ?? {})
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
function fallbackReply(actions: (PatientAction & { delivered: boolean })[]): string {
  if (actions.some((a) => !a.delivered)) {
    return "I couldn't reach the nursing staff. Please press your call button now."
  }
  if (actions.some((a) => a.type === 'emergency')) {
    return "I've alerted the nursing staff and help is on the way. Please press your call button now if you can."
  }
  if (actions.length) return "I've let the staff know. Someone will be with you soon."
  return "Sorry, I didn't catch that. Could you say it again?"
}
