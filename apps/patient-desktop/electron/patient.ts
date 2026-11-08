// Which patient this device belongs to.
//
// Each patient app instance is assigned to ONE patient by their pseudonymous Patient.id (the
// Synthea id used as `patients.id` in Supabase). Never a bed label: beds are display-only and get
// reused (CLAUDE.md).
//
// Set it per device in apps/patient-desktop/.env (gitignored; see .env.example):
//   PATIENT_ID=8398b128-7c86-69f2-456a-a0afb52067c1
// A real environment variable takes precedence over the .env file.
import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type PatientAssignment =
  | { patientId: string; warning?: string }
  | { patientId: null; error: string }

// Synthea ids are UUID-shaped (8-4-4-4-12 hex).
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let assignment: PatientAssignment | null = null

/** Load PATIENT_ID once at startup. Call after APP_ROOT is set (in main.ts). */
export function loadPatientAssignment(): PatientAssignment {
  // Dev: apps/patient-desktop/.env   Packaged: <userData>/.env (set up when the device is installed)
  const envFile = app.isPackaged
    ? path.join(app.getPath('userData'), '.env')
    : path.join(process.env.APP_ROOT, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile) // doesn't override real env variables

  const id = process.env.PATIENT_ID?.trim()
  if (!id) {
    assignment = { patientId: null, error: `PATIENT_ID is not set. Add it to ${envFile} (see .env.example).` }
  } else if (!ID_PATTERN.test(id)) {
    assignment = { patientId: null, error: `PATIENT_ID "${id}" is not a valid patient id (expected a UUID).` }
  } else {
    assignment = { patientId: id.toLowerCase(), warning: devWarning(id.toLowerCase()) }
  }

  if (assignment.patientId === null) console.error(`[patient] ${assignment.error}`)
  else {
    console.log(`[patient] Assigned to patient ${assignment.patientId}`)
    if (assignment.warning) console.warn(`[patient] ${assignment.warning}`)
  }
  return assignment
}

export function getPatientAssignment(): PatientAssignment {
  if (!assignment) throw new Error('loadPatientAssignment() has not run yet')
  return assignment
}

/** In development, check the id against the scrubbed patients the simulator uses. */
function devWarning(id: string): string | undefined {
  if (app.isPackaged) return undefined
  const cleanDir = path.join(process.env.APP_ROOT, '..', '..', 'server', 'data', 'clean')
  if (!existsSync(cleanDir)) return undefined
  if (!existsSync(path.join(cleanDir, `${id}.json`))) {
    return `PATIENT_ID ${id} is not one of the patients in server/data/clean/ — check for a typo.`
  }
  return undefined
}
