// Supabase browser client for the nurse dashboard.
//
// Uses the publishable key: data is only readable after sign-in (Row Level Security, see
// server/supabase/migrations/). Never put the secret key in this app.
//
// Env (apps/nurse-web/.env locally, Vercel project settings in production):
//   VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
// If they're missing, the sign-in page explains how to set them (instead of crashing).

import { createClient, type RealtimeChannel, type Session, type SupabaseClient } from '@supabase/supabase-js'
import {
  type AlertStatus,
  encounterFromRow,
  patientFromRow,
  vitalsFromRow,
  type AlertRow,
  type Encounter,
  type EncounterRow,
  type Patient,
  type PatientRow,
  type VitalsReading,
  type VitalsRow,
} from '@repo/shared'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/** True when the Supabase env vars are set. */
export const supabaseConfigured = Boolean(url && publishableKey)

export const supabase: SupabaseClient | null = supabaseConfigured ? createClient(url!, publishableKey!) : null

function client(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. Copy apps/nurse-web/.env.example to ' +
        'apps/nurse-web/.env (or set them in Vercel).',
    )
  }
  return supabase
}

// ---------- auth (staff accounts are created in Supabase → Authentication) ----------

export async function getSession(): Promise<Session | null> {
  const { data } = await client().auth.getSession()
  return data.session
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await client().auth.signInWithPassword({ email, password })
  if (error) throw error
}

export async function signOut(): Promise<void> {
  await client().auth.signOut()
}

export function onAuthChange(cb: (session: Session | null) => void): () => void {
  const { data } = client().auth.onAuthStateChange((_event, session) => cb(session))
  return () => data.subscription.unsubscribe()
}

// ---------- data ----------

/** Patients and their current in-progress encounters (bed = `encounter.location.display`). */
export async function fetchWard(): Promise<{ patients: Patient[]; encounters: Encounter[] }> {
  const db = client()
  const [patients, encounters] = await Promise.all([
    db.from('patients').select('*'),
    db.from('encounters').select('*').eq('status', 'in-progress'),
  ])
  if (patients.error) throw patients.error
  if (encounters.error) throw encounters.error
  return {
    patients: (patients.data as PatientRow[]).map(patientFromRow),
    encounters: (encounters.data as EncounterRow[]).map(encounterFromRow),
  }
}

/** All patients (pseudonymous; see PatientRow). */
export async function fetchPatients(): Promise<Patient[]> {
  const { data, error } = await client().from('patients').select('*')
  if (error) throw error
  return (data as PatientRow[]).map(patientFromRow)
}

/** Encounter rows (we need `patient_id` to link a bed to its patient). */
export async function fetchEncounterRows(): Promise<EncounterRow[]> {
  const { data, error } = await client().from('encounters').select('*').eq('status', 'in-progress')
  if (error) throw error
  return data as EncounterRow[]
}

/** Each patient's latest reading (the `vitals` table holds one row per patient). */
export async function fetchLatestVitals(): Promise<VitalsReading[]> {
  const { data, error } = await client().from('vitals').select('*')
  if (error) throw error
  return (data as VitalsRow[]).map(vitalsFromRow)
}

/** Alerts created since `sinceIso` (e.g. midnight), oldest first. */
export async function fetchAlertsSince(sinceIso: string): Promise<AlertRow[]> {
  const { data, error } = await client()
    .from('alerts')
    .select('*')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data as AlertRow[]
}

/** Incomplete alerts, whenever they were created. */
export async function fetchIncompleteAlerts(): Promise<AlertRow[]> {
  const { data, error } = await client().from('alerts').select('*').eq('status', 'incomplete')
  if (error) throw error
  return data as AlertRow[]
}

/**
 * Live vitals + alerts. Returns an unsubscribe function (call it on unmount).
 * The simulator updates each patient's `vitals` row in place every tick, so this listens for
 * UPDATE (and the first INSERT). Keep any history you want to chart in component state.
 */
export function subscribeToWard(handlers: {
  onVitals?: (reading: VitalsReading) => void
  onAlert?: (alert: AlertRow) => void
  /** A row was deleted (e.g. the simulator resets its tables on start). */
  onVitalsDeleted?: (patientId: string) => void
  onAlertDeleted?: (alertId: number) => void
}): () => void {
  const db = client()
  // A DELETE has no new row; `old` carries the primary key (all Realtime sends with RLS on).
  const channel: RealtimeChannel = db
    .channel('ward')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vitals' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        const patientId = (payload.old as Partial<VitalsRow>).patient_id
        if (patientId) handlers.onVitalsDeleted?.(patientId)
      } else handlers.onVitals?.(vitalsFromRow(payload.new as VitalsRow))
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        const alertId = (payload.old as Partial<AlertRow>).id
        if (alertId !== undefined) handlers.onAlertDeleted?.(alertId)
      } else handlers.onAlert?.(payload.new as AlertRow)
    })
    .subscribe()
  return () => {
    void db.removeChannel(channel)
  }
}

/** Mark an alert completed (or back to incomplete). The database sets `completed_at` itself. */
export async function setAlertStatus(id: number, status: AlertStatus): Promise<void> {
  const { error } = await client().from('alerts').update({ status }).eq('id', id)
  if (error) throw error
}
