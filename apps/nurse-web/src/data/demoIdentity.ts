// DEMO ONLY: hard-coded, fictional identification details for the 5 demo-ward patients
// (DEMO_WARD in server/sim/vitals_sim.py). Not in Supabase. Lets the nurse confirm two
// identifiers (name + date of birth) before going to the bedside.
// Keyed on Patient.id, never the bed label.

export type DemoIdentity = {
  name: string
  dob: string // ISO date, consistent with the patient's age band
  mrn: string
  allergies: string
}

export const DEMO_IDENTITY: Record<string, DemoIdentity> = {
  '8398b128-7c86-69f2-456a-a0afb52067c1': { name: 'Harold Jennings', dob: '1941-03-14', mrn: 'MRN 4410-2287', allergies: 'Penicillin' },
  '5a4445ed-e27a-6c4c-96bd-307b7bbee226': { name: 'Margaret Okafor', dob: '1943-07-22', mrn: 'MRN 4410-3051', allergies: 'No known allergies' },
  '9020f065-b607-4ea6-719f-2ea65bb06c8b': { name: 'Walter Brennan', dob: '1950-11-02', mrn: 'MRN 4410-1764', allergies: 'Sulfa drugs' },
  '1ebf325c-5fd9-9259-79cf-44f209b97ee8': { name: 'Linda Park', dob: '1961-05-09', mrn: 'MRN 4410-2903', allergies: 'Latex' },
  '94011f7c-9aaa-e26e-a4e8-fe735f840734': { name: 'Raymond Diaz', dob: '1958-09-30', mrn: 'MRN 4410-3378', allergies: 'No known allergies' },
}

export const demoIdentity = (patientId: string): DemoIdentity | undefined => DEMO_IDENTITY[patientId]

/** "14 Mar 1941" */
export const formatDob = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
