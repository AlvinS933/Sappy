// Supabase browser client for the nurse dashboard.
//
// Uses the publishable key: data is only readable after sign-in (Row Level Security, see
// supabase/migrations/). Never put the secret key in this app.
//
// Env (apps/nurse-web/.env locally, Vercel project settings in production):
//   VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY

import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import {
  vitalsFromRow,
  type AlertRow,
  type EncounterRow,
  type PatientRow,
  type VitalsReading,
  type VitalsRow,
} from '@repo/shared'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!url || !publishableKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. Copy apps/nurse-web/.env.example to ' +
      'apps/nurse-web/.env (or set them in Vercel).',
  )
}

export const supabase = createClient(url, publishableKey)

/** Patients with their current in-progress encounter (bed). */
export async function fetchWard(): Promise<{ patients: PatientRow[]; encounters: EncounterRow[] }> {
  const [patients, encounters] = await Promise.all([
    supabase.from('patients').select('*'),
    supabase.from('encounters').select('*').eq('status', 'in-progress'),
  ])
  if (patients.error) throw patients.error
  if (encounters.error) throw encounters.error
  return { patients: patients.data as PatientRow[], encounters: encounters.data as EncounterRow[] }
}

/** Latest `limit` readings across the ward, newest first (for the first paint before Realtime). */
export async function fetchRecentVitals(limit = 500): Promise<VitalsReading[]> {
  const { data, error } = await supabase
    .from('vitals')
    .select('*')
    .order('recorded_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data as VitalsRow[]).map(vitalsFromRow)
}

/** Live vitals + alerts. Returns an unsubscribe function (call it on unmount). */
export function subscribeToWard(handlers: {
  onVitals?: (reading: VitalsReading) => void
  onAlert?: (alert: AlertRow) => void
}): () => void {
  const channel: RealtimeChannel = supabase
    .channel('ward')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'vitals' }, (payload) =>
      handlers.onVitals?.(vitalsFromRow(payload.new as VitalsRow)),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, (payload) => {
      if (payload.new && 'id' in payload.new) handlers.onAlert?.(payload.new as AlertRow)
    })
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}

export async function acknowledgeAlert(id: number): Promise<void> {
  const { error } = await supabase.from('alerts').update({ acknowledged_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
}
