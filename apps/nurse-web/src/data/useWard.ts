// Loads the ward from Supabase and keeps it live with Realtime:
//   beds    = in-progress encounters joined to patients
//   vitals  = latest reading per patient (updated in place by the simulator)
//   alerts  = NEWS2 `alerts` + bedside-app `patient_requests`, each: every incomplete one plus
//             everything from the last 24 hours. Shown together as WardAlerts.
import { useCallback, useEffect, useState } from 'react'
import type { AlertStatus, PatientRequestRow, VitalsReading } from '@repo/shared'
import {
  fetchAlertsSince,
  fetchEncounterRows,
  fetchIncompleteAlerts,
  fetchIncompleteRequests,
  fetchLatestVitals,
  fetchPatients,
  fetchRequestsSince,
  setItemStatus,
  subscribeToWard,
} from '../lib/supabase'
import { byBedLabel, fromAlertRow, fromRequestRow, windowStart, type Bed, type Ward, type WardAlert } from './model'

export type WardState = {
  ward: Ward | null
  error: string | null
  /** Non-fatal problem, e.g. the patient_requests table doesn't exist yet. */
  warning: string | null
  /** Whether live updates are connected (null while connecting). */
  live: boolean | null
  /** When the last live update arrived (vitals, alerts or requests). */
  lastUpdate: Date | null
  /** Mark a NEWS2 alert or patient request completed or incomplete. */
  setStatus: (alert: WardAlert, status: AlertStatus) => Promise<void>
}

const byCreated = (a: WardAlert, b: WardAlert) => a.created_at.localeCompare(b.created_at)

const upsert = (alerts: WardAlert[], item: WardAlert) =>
  alerts.some((a) => a.key === item.key) ? alerts.map((a) => (a.key === item.key ? item : a)) : [...alerts, item].sort(byCreated)

const withVitals = (ward: Ward, reading: VitalsReading): Ward => ({
  ...ward,
  beds: ward.beds.map((b) => (b.patient.id === reading.patientId ? { ...b, vitals: reading } : b)),
})

/** Union by key (the "recent" and "incomplete" queries overlap). */
function merge(...lists: WardAlert[][]): WardAlert[] {
  const byKey = new Map<string, WardAlert>()
  for (const list of lists) for (const a of list) byKey.set(a.key, a)
  return [...byKey.values()].sort(byCreated)
}

const MISSING_REQUESTS_TABLE =
  "Patient requests aren't available: the patient_requests table doesn't exist yet. " +
  'Apply server/supabase/migrations/20261108020000_patient_requests.sql in Supabase. Showing NEWS2 alerts only.'

/** Patient requests are optional: if their table is missing, show NEWS2 alerts only. */
async function loadRequests(since: string): Promise<{ rows: PatientRequestRow[]; missing: boolean }> {
  try {
    const [incomplete, recent] = await Promise.all([fetchIncompleteRequests(), fetchRequestsSince(since)])
    return { rows: [...incomplete, ...recent], missing: false }
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'PGRST205' || code === '42P01') return { rows: [], missing: true } // table not found
    throw err
  }
}

async function loadWard(): Promise<{ ward: Ward; warning: string | null }> {
  const since = windowStart().toISOString()
  const [encounters, patients, vitals, incompleteAlerts, recentAlerts, requests] = await Promise.all([
    fetchEncounterRows(),
    fetchPatients(),
    fetchLatestVitals(),
    fetchIncompleteAlerts(),
    fetchAlertsSince(since),
    loadRequests(since),
  ])
  const beds: Bed[] = []
  for (const e of encounters) {
    const patient = patients.find((p) => p.id === e.patient_id)
    if (patient) beds.push({ patient, encounterId: e.id, label: e.bed_label, vitals: vitals.find((v) => v.patientId === patient.id) })
  }
  const alerts = merge([...incompleteAlerts, ...recentAlerts].map(fromAlertRow), requests.rows.map(fromRequestRow))
  return { ward: { beds: beds.sort(byBedLabel), alerts }, warning: requests.missing ? MISSING_REQUESTS_TABLE : null }
}

export function useWard(): WardState {
  const [ward, setWard] = useState<Ward | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      loadWard().then(
        ({ ward: w, warning: notice }) => {
          if (cancelled) return
          setWard(w)
          setWarning(notice)
          setError(null)
          setLastUpdate(new Date())
        },
        (err) => !cancelled && setError(err?.message ?? String(err)),
      )
    void load()

    // After deletions, reload everything once things settle: a simulator reset also changes
    // patients/encounters, which Realtime doesn't push. Debounced so a bulk wipe = one reload.
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const reloadSoon = () => {
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => void load(), 1500)
    }
    const changed = (update: (w: Ward) => Ward) => {
      setWard((w) => (w ? update(w) : w))
      setLastUpdate(new Date())
    }
    const removeKey = (key: string) => {
      changed((w) => ({ ...w, alerts: w.alerts.filter((a) => a.key !== key) }))
      reloadSoon()
    }

    const handlers: Parameters<typeof subscribeToWard>[0] = {
      onVitals: (reading) => changed((w) => withVitals(w, reading)),
      onAlert: (row) => changed((w) => ({ ...w, alerts: upsert(w.alerts, fromAlertRow(row)) })),
      onRequest: (row) => changed((w) => ({ ...w, alerts: upsert(w.alerts, fromRequestRow(row)) })),
      // Deleted rows disappear from the screen immediately, then the ward is re-synced.
      onAlertDeleted: (id) => removeKey(`alerts:${id}`),
      onRequestDeleted: (id) => removeKey(`patient_requests:${id}`),
      onVitalsDeleted: (patientId) => {
        changed((w) => ({ ...w, beds: w.beds.map((b) => (b.patient.id === patientId ? { ...b, vitals: undefined } : b)) }))
        reloadSoon()
      },
      onStatus: (status) => {
        if (cancelled) return
        setLive(status === 'live')
        if (status === 'live') {
          void load() // catch up on anything missed while disconnected
        } else {
          // Reconnect with a fresh subscription after a short pause.
          unsubscribe()
          clearTimeout(retryTimer)
          retryTimer = setTimeout(() => {
            if (!cancelled) unsubscribe = subscribeToWard(handlers)
          }, 5000)
        }
      },
    }
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = subscribeToWard(handlers)

    // Safety net: re-sync every 30 s and when the tab becomes visible again, so the screen is
    // never stale for long even if a live update is missed.
    const poll = setInterval(() => void load(), 30_000)
    const onVisible = () => document.visibilityState === 'visible' && void load()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearTimeout(reloadTimer)
      clearTimeout(retryTimer)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [])

  const setStatus = useCallback(async (alert: WardAlert, status: AlertStatus) => {
    // Optimistic: update the screen right away; Realtime then delivers the saved row
    // (with the database's own completed_at).
    const completedAt = status === 'completed' ? new Date().toISOString() : null
    setWard((w) => w && { ...w, alerts: w.alerts.map((a) => (a.key === alert.key ? { ...a, status, completed_at: completedAt } : a)) })
    try {
      await setItemStatus(alert.table, alert.id, status)
    } catch (err) {
      setWard((w) => w && { ...w, alerts: w.alerts.map((a) => (a.key === alert.key ? alert : a)) })
      throw err
    }
  }, [])

  return { ward, error, warning, live, lastUpdate, setStatus }
}
