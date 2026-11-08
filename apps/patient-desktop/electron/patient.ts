// Which patient this device plays, and the Supabase connection used to send alerts.
//
// Demo mode, no sign-in: the app connects with the publishable key only and asks the database
// for its patient via `patient_device_assignment()`, which returns the first patient (by id)
// that has an in-progress stay. See server/supabase/migrations/20261108010000_patient_device.sql.
//
// Settings: apps/patient-desktop/.env (gitignored; see .env.example)
//   SUPABASE_URL=https://<project>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY=sb_publishable_...   (never the secret key)
// A real environment variable takes precedence over the .env file.
import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type PatientAssignment =
  | { patientId: string; encounterId: string; bedLabel: string }
  | { patientId: null; error: string }

let client: SupabaseClient | null = null
let assignment: Promise<PatientAssignment> | null = null

function loadEnv() {
  // Dev: apps/patient-desktop/.env   Packaged: <userData>/.env (set up when the device is installed)
  const envFile = app.isPackaged ? path.join(app.getPath('userData'), '.env') : path.join(process.env.APP_ROOT, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile) // doesn't override real env variables
  return envFile
}

/** Supabase client with the publishable key (no session: this app never signs in). */
export function getSupabase(): SupabaseClient | null {
  return client
}

async function resolveAssignment(): Promise<PatientAssignment> {
  const envFile = loadEnv()
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
  if (!url || !key) {
    return { patientId: null, error: `SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set. Add them to ${envFile} (see .env.example).` }
  }
  if (key.startsWith('sb_secret_')) {
    return { patientId: null, error: 'SUPABASE_PUBLISHABLE_KEY is a secret key. Use the publishable key (sb_publishable_...).' }
  }

  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.rpc('patient_device_assignment')
  if (error) {
    return { patientId: null, error: `Couldn't get a patient from the database: ${error.message}` }
  }
  const row = (data as { patient_id: string; encounter_id: string; bed_label: string }[] | null)?.[0]
  if (!row) {
    return { patientId: null, error: 'No patient with an in-progress stay in the database (is the simulator running?).' }
  }
  return { patientId: row.patient_id, encounterId: row.encounter_id, bedLabel: row.bed_label }
}

/** Look up this device's patient once at startup. Call after APP_ROOT is set (in main.ts). */
export function loadPatientAssignment(): Promise<PatientAssignment> {
  assignment ??= resolveAssignment().then((a) => {
    if (a.patientId === null) console.error(`[patient] ${a.error}`)
    else console.log(`[patient] Playing patient ${a.patientId} (bed ${a.bedLabel})`)
    return a
  })
  return assignment
}

/** The assignment (waits for the startup lookup if it's still running). */
export function getPatientAssignment(): Promise<PatientAssignment> {
  return loadPatientAssignment()
}
