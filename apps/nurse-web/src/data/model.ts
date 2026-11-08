// View model for the nurse dashboard. Everything here is derived from the Supabase tables
// (server/supabase/migrations/): patients, encounters, vitals, alerts, patient_requests.
//
// NEWS2 `alerts` and the bedside app's `patient_requests` are separate tables (so the NEWS2 worker
// can't touch patient requests) but are shown together: both become a WardAlert.
//
// Privacy (CLAUDE.md): patients are shown by bed + age band + sex + short pseudonymous id. There
// are no names; alert reasons are NEWS2 explanations, never patient free text.
import type { AlertRow, AlertStatus, AlertTier, Patient, PatientRequestRow, VitalsReading } from '@repo/shared'

/** One occupied bed (an in-progress encounter): the patient and their latest vitals. */
export type Bed = {
  patient: Patient
  encounterId: string
  label: string // `encounters.bed_label`: display only, never a key
  vitals?: VitalsReading
}

export type Ward = {
  beds: Bed[]
  /** NEWS2 alerts + patient requests in scope (see inScope), oldest first. */
  alerts: WardAlert[]
}

/** One item in the nurses' queue: a NEWS2 alert or a patient request, in a common shape. */
export type WardAlert = {
  /** Unique across both tables, e.g. "alerts:12" or "patient_requests:5" (ids are per table). */
  key: string
  table: 'alerts' | 'patient_requests'
  id: number
  patient_id: string
  encounter_id: string
  created_at: string
  tier: AlertTier
  status: AlertStatus
  completed_at: string | null
  origin: 'news2' | 'patient'
  news2Score: number | null
  /** Headline, e.g. "Respiratory rate 25/min" or "Help to the bathroom". */
  title: string
  /** Full explanation: the NEWS2 breakdown, or how the patient's request came in. */
  detail: string
  /** Short tag, e.g. "NEWS2 7" or "Patient request". */
  tag: string
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function fromAlertRow(r: AlertRow): WardAlert {
  const reasons = r.reason.split('; ').filter(Boolean)
  return {
    key: `alerts:${r.id}`, table: 'alerts', id: r.id, patient_id: r.patient_id, encounter_id: r.encounter_id,
    created_at: r.created_at, tier: r.tier, status: r.status, completed_at: r.completed_at,
    origin: 'news2', news2Score: r.news2_score,
    // First NEWS2 reason without its point value, e.g. "Respiratory rate 25/min".
    title: reasons[0]?.replace(/ \(\+\d+\)$/, '') ?? r.reason,
    detail: reasons.join(' · '),
    tag: r.news2_score !== null ? `NEWS2 ${r.news2_score}` : 'NEWS2',
  }
}

const REQUEST_TITLE: Record<PatientRequestRow['kind'], (label: string) => string> = {
  item_request: (l) => `Requested ${l}`,
  nurse_call: (l) => capitalize(l),
  emergency: (l) => `Possible emergency: ${l}`,
}

export function fromRequestRow(r: PatientRequestRow): WardAlert {
  return {
    key: `patient_requests:${r.id}`, table: 'patient_requests', id: r.id, patient_id: r.patient_id, encounter_id: r.encounter_id,
    created_at: r.created_at, tier: r.tier, status: r.status, completed_at: r.completed_at,
    origin: 'patient', news2Score: null,
    title: REQUEST_TITLE[r.kind](r.label),
    detail: r.source === 'safety_check' ? 'Patient request via bedside app · caught by the keyword safety check' : 'Patient request via bedside app',
    tag: 'Patient request',
  }
}

// ---------- tiers (the `alerts.tier` values, NEWS2 clinical response bands) ----------

export const TIER: Record<AlertTier, { label: string; className: string; rank: number }> = {
  'go now': { label: 'Go now', className: 'go-now', rank: 3 },
  'check soon': { label: 'Check soon', className: 'check-soon', rank: 2 },
  watch: { label: 'Watch', className: 'watch', rank: 1 },
}

export const isIncomplete = (a: WardAlert) => a.status === 'incomplete'

/** Most severe first, then whoever has waited longest. */
export function byPriority(a: WardAlert, b: WardAlert): number {
  return TIER[b.tier].rank - TIER[a.tier].rank || a.created_at.localeCompare(b.created_at)
}

// ---------- patients ----------

const SEX_SHORT: Record<string, string> = { male: 'M', female: 'F', other: 'X' }
export const SEX_LABEL: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other', unknown: 'Unknown' }

/** "80-89 F" */
export const patientSummary = (p: Patient) => [p.ageBand, SEX_SHORT[p.gender ?? '']].filter(Boolean).join(' ')

/** Short pseudonymous id, e.g. "5a4445ed" (tells records apart without a name). */
export const shortId = (p: Patient) => p.id.slice(0, 8)

export const bedForAlert = (ward: Ward, a: WardAlert) => ward.beds.find((b) => b.patient.id === a.patient_id)

/** Highest tier among a bed's incomplete alerts, or null if none. */
export function incompleteTier(ward: Ward, bed: Bed): AlertTier | null {
  return ward.alerts.filter((a) => a.patient_id === bed.patient.id && isIncomplete(a)).sort(byPriority)[0]?.tier ?? null
}

export const byBedLabel = (a: Bed, b: Bed) => a.label.localeCompare(b.label, undefined, { numeric: true })

// ---------- time ----------

/** The dashboard covers a rolling 24-hour window (no midnight cut-off for night staff). */
export const WINDOW_HOURS = 24
export const windowStart = (now = new Date()) => new Date(now.getTime() - WINDOW_HOURS * 3600_000)

/** Shown everywhere: created in the last 24 hours, or still incomplete (however old). */
export const inScope = (a: WardAlert, now = new Date()) => isIncomplete(a) || new Date(a.created_at) >= windowStart(now)

export const minutesBetween = (fromIso: string, to: Date | string) =>
  Math.max(0, (new Date(to).getTime() - new Date(fromIso).getTime()) / 60_000)

/** "0:42" (m:ss) or "1:05:09" for live waiting timers. */
export function clock(fromIso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "3 min", "1 h 5 min" */
export function duration(minutes: number): string {
  if (minutes < 1) return '<1 min'
  const m = Math.round(minutes)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export const timeOfDay = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`

// ---------- stats ----------

export function alertStats(alerts: WardAlert[]) {
  const completed = alerts.filter((a) => a.status === 'completed' && a.completed_at)
  const responseMins = completed.map((a) => minutesBetween(a.created_at, a.completed_at!))
  return {
    total: alerts.length,
    completed: completed.length,
    incomplete: alerts.filter(isIncomplete).length,
    goNow: alerts.filter((a) => a.tier === 'go now').length,
    avgResponse: responseMins.length ? responseMins.reduce((s, m) => s + m, 0) / responseMins.length : null,
  }
}

/** Average time to complete, grouped by the hour the alert was created. */
export function responseByHour(alerts: WardAlert[]): { hour: number; avg: number }[] {
  const groups = new Map<number, number[]>()
  for (const a of alerts) {
    if (a.status !== 'completed' || !a.completed_at) continue
    const hour = new Date(a.created_at).getHours()
    groups.set(hour, [...(groups.get(hour) ?? []), minutesBetween(a.created_at, a.completed_at)])
  }
  return [...groups].sort(([a], [b]) => a - b).map(([hour, ms]) => ({ hour, avg: ms.reduce((s, m) => s + m, 0) / ms.length }))
}
