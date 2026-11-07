// Types and helpers shared by the nurse dashboard and the patient app.

export interface Patient {
  id: string
  firstName: string
  lastName: string
  room?: string
}

export interface VitalsReading {
  patientId: string
  recordedAt: string // ISO 8601
  heartRateBpm?: number
  systolicMmHg?: number
  diastolicMmHg?: number
  spo2Percent?: number
  temperatureC?: number
  respiratoryRate?: number // breaths/min
  onOxygen?: boolean // supplemental oxygen (false = room air)
  consciousness?: Consciousness
}

/** ACVPU: Alert, new Confusion, responds to Voice, responds to Pain, Unresponsive. */
export type Consciousness = 'A' | 'C' | 'V' | 'P' | 'U'

export function patientDisplayName(p: Pick<Patient, 'firstName' | 'lastName'>): string {
  return `${p.firstName} ${p.lastName}`
}
