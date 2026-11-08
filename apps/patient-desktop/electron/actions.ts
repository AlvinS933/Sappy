// Actions the assistant takes on the patient's behalf (item requests, nurse calls, emergencies),
// and how they map onto rows in the Supabase `alerts` table.
//
// Privacy (CLAUDE.md): nothing the patient said goes into an alert. The model picks from fixed
// categories below, and the alert `reason` is built only from those. The patient's own words stay
// in `local` (terminal log on this device) and are never sent anywhere.
//
// `dispatchAction` sends each action to Supabase as an `alerts` row (via the database function
// submit_patient_alert, which also looks up the patient's in-progress encounter), and logs it.
import { randomUUID } from 'node:crypto'
import type { AlertTier, NewAlertRow } from '@repo/shared'

// ---------- categories the model chooses from ----------

export const ITEM_CATEGORIES = ['drink', 'food', 'comfort', 'hygiene', 'other'] as const
export const NURSE_REASONS = ['bathroom', 'pain', 'mobility', 'equipment', 'medication', 'comfort', 'talk', 'other'] as const
export const EMERGENCY_KINDS = [
  'chest_pain', 'breathing', 'fall', 'stroke_signs', 'bleeding', 'seizure', 'fainting', 'severe_pain', 'self_harm', 'other',
] as const

export type ItemCategory = (typeof ITEM_CATEGORIES)[number]
export type NurseReason = (typeof NURSE_REASONS)[number]
export type EmergencyKind = (typeof EMERGENCY_KINDS)[number]

const ITEM_CATEGORY_LABEL: Record<ItemCategory, string> = {
  drink: 'a drink', food: 'food', comfort: 'a comfort item', hygiene: 'a hygiene item', other: 'an item',
}
const NURSE_REASON_LABEL: Record<NurseReason, string> = {
  bathroom: 'help to the bathroom',
  pain: 'pain or discomfort',
  mobility: 'help moving or getting up',
  equipment: 'equipment alarm or problem',
  medication: 'a medication question',
  comfort: 'comfort or repositioning',
  talk: 'wants to talk to the nurse',
  other: 'needs the nurse',
}
const EMERGENCY_LABEL: Record<EmergencyKind, string> = {
  chest_pain: 'chest pain',
  breathing: 'trouble breathing',
  fall: 'a fall',
  stroke_signs: 'possible stroke signs',
  bleeding: 'heavy bleeding',
  seizure: 'a seizure',
  fainting: 'fainting or about to faint',
  severe_pain: 'sudden severe pain',
  self_harm: 'thoughts of self-harm',
  other: 'other symptoms',
}

// Common items that may be named in an alert. Anything else is reported by its category only.
const NAMED_ITEMS = [
  'ice chips', 'water', 'ice', 'juice', 'coffee', 'tea', 'milk', 'snack', 'meal', 'blanket', 'pillow',
  'tissues', 'towel', 'toothbrush', 'toothpaste', 'lip balm', 'socks', 'reading glasses', 'phone charger', 'tv remote',
]

// ---------- the action record ----------

type Base = {
  id: string
  /** Pseudonymous Patient.id this device plays (null if it has no patient). */
  patientId: string | null
  /** Short label for the patient's screen and staff, e.g. "water" or "help to the bathroom". Never free text. */
  label: string
  /** 'assistant' = the AI chose this action; 'safety_check' = keyword safety net (no AI involved). */
  source: 'assistant' | 'safety_check'
  createdAt: string // ISO 8601
  /** Stays on this device (terminal log only). NEVER sent to Supabase. */
  local: { patientMessage: string; detail?: string }
}

export type PatientAction =
  | (Base & { type: 'item_request'; priority: 'routine'; category: ItemCategory })
  | (Base & { type: 'nurse_call'; priority: 'routine' | 'soon' | 'urgent'; category: NurseReason })
  | (Base & { type: 'emergency'; priority: 'emergency'; category: EmergencyKind })

type NewAction =
  | { type: 'item_request'; category: ItemCategory; item?: string }
  | { type: 'nurse_call'; category: NurseReason; priority: 'routine' | 'soon' | 'urgent' }
  | { type: 'emergency'; category: EmergencyKind }

/** Build an action. `item` (free text from the model) is only kept if it's a common named item. */
export function createAction(
  spec: NewAction,
  ctx: { patientId: string | null; source: Base['source']; patientMessage: string; detail?: string },
): PatientAction {
  const base = {
    id: randomUUID(),
    patientId: ctx.patientId,
    source: ctx.source,
    createdAt: new Date().toISOString(),
    local: { patientMessage: ctx.patientMessage, ...(ctx.detail && { detail: ctx.detail }) },
  }
  switch (spec.type) {
    case 'item_request': {
      const named = spec.item ? NAMED_ITEMS.find((n) => spec.item!.toLowerCase().includes(n)) : undefined
      return { ...base, type: 'item_request', priority: 'routine', category: spec.category, label: named ?? ITEM_CATEGORY_LABEL[spec.category] }
    }
    case 'nurse_call':
      return { ...base, type: 'nurse_call', priority: spec.priority, category: spec.category, label: NURSE_REASON_LABEL[spec.category] }
    case 'emergency':
      return { ...base, type: 'emergency', priority: 'emergency', category: spec.category, label: EMERGENCY_LABEL[spec.category] }
  }
}

// ---------- mapping onto the `alerts` table ----------

/**
 * Tier, using the same scale as NEWS2 alerts so the nurse dashboard can sort them together:
 *   emergency            → go now
 *   nurse call urgent    → check soon
 *   nurse call soon      → check soon
 *   nurse call routine   → watch
 *   item request         → watch
 */
export function alertTier(action: PatientAction): AlertTier {
  if (action.type === 'emergency') return 'go now'
  if (action.type === 'nurse_call' && action.priority !== 'routine') return 'check soon'
  return 'watch'
}

/** Plain-language reason built only from fixed categories (no patient free text). */
export function alertReason(action: PatientAction): string {
  switch (action.type) {
    case 'item_request':
      return `Patient request: ${action.label}`
    case 'nurse_call':
      return `Patient asked for the nurse: ${action.label}`
    case 'emergency':
      return `Patient reported a possible emergency: ${action.label}` + (action.source === 'safety_check' ? ' (keyword safety check)' : '')
  }
}

/**
 * The `alerts` row for this action, minus `encounter_id`: the database looks up the patient's
 * current in-progress stay when the row is inserted.
 */
export function toAlertRow(action: PatientAction): Omit<NewAlertRow, 'encounter_id'> | null {
  if (!action.patientId) return null
  return { patient_id: action.patientId, tier: alertTier(action), news2_score: null, reason: alertReason(action) }
}

// ---------- delivery ----------

const ICON = { item_request: '🥤', nurse_call: '🔔', emergency: '🚨' } as const

/** Inserts an alerts row and returns its id (see electron/ai.ts). */
export type SubmitAlert = (row: Omit<NewAlertRow, 'encounter_id'>) => Promise<number>

/**
 * Deliver an action to staff: insert it into the `alerts` table, and log it.
 * Resolves true if the database accepted it, false otherwise (never throws).
 */
export async function dispatchAction(action: PatientAction, submit: SubmitAlert | null): Promise<boolean> {
  const row = toAlertRow(action)
  let result: string
  let delivered = false
  if (!row || !submit) {
    result = 'NOT SENT: this device has no patient / database connection (see the [patient] message above)'
  } else {
    try {
      const alertId = await submit(row)
      delivered = true
      result = `sent to alerts (id ${alertId}):\n${JSON.stringify(row, null, 2)}`
    } catch (err) {
      result = `NOT SENT: database error: ${(err as Error)?.message ?? err}`
    }
  }
  const log = action.type === 'emergency' || !delivered ? console.error : console.log
  log(
    `\n[patient-action] ${ICON[action.type]} [${alertTier(action).toUpperCase()}] ${alertReason(action)}\n${result}\n` +
      `local only, never sent: ${JSON.stringify({ id: action.id, source: action.source, ...action.local })}\n`,
  )
  return delivered
}
