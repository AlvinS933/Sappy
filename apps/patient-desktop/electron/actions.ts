// Actions the assistant takes on the patient's behalf (item requests, nurse calls, emergencies).
//
// For now they are only logged to the terminal. Later, `dispatchAction` is the one place to
// change to send them to the database / nurse dashboard.
import { randomUUID } from 'node:crypto'

export type ActionType = 'item_request' | 'nurse_call' | 'emergency'
export type Priority = 'routine' | 'soon' | 'urgent' | 'emergency'

export type PatientAction = {
  id: string
  type: ActionType
  priority: Priority
  /** One-line description for staff, e.g. "Water" or "Help getting to the bathroom". */
  summary: string
  /** Type-specific fields (item category, symptoms, …). */
  details: Record<string, string>
  /** What the patient said that led to this action. */
  patientMessage: string
  /** 'assistant' = the AI chose this action; 'safety_check' = keyword safety net (no AI involved). */
  source: 'assistant' | 'safety_check'
  createdAt: string // ISO 8601
}

export function createAction(fields: Omit<PatientAction, 'id' | 'createdAt'>): PatientAction {
  return { id: randomUUID(), createdAt: new Date().toISOString(), ...fields }
}

const ICON: Record<ActionType, string> = { item_request: '🥤', nurse_call: '🔔', emergency: '🚨' }

/** Deliver an action to staff. TODO: send to the database / nurse dashboard instead of logging. */
export function dispatchAction(action: PatientAction) {
  const headline = `${ICON[action.type]} [${action.priority.toUpperCase()}] ${action.type}: ${action.summary}`
  const log = action.type === 'emergency' ? console.error : console.log
  log(`\n[patient-action] ${headline}\n${JSON.stringify(action, null, 2)}\n`)
}
