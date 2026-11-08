// Loads the ward from Supabase and keeps it live with Realtime:
//   beds    = in-progress encounters joined to patients
//   vitals  = latest reading per patient (updated in place by the simulator)
//   alerts  = every incomplete alert + everything from the last 24 hours (written by the NEWS2 worker)
import { useCallback, useEffect, useState } from 'react'
import type { AlertRow, AlertStatus, VitalsReading } from '@repo/shared'
import {
  fetchAlertsSince,
  fetchEncounterRows,
  fetchIncompleteAlerts,
  fetchLatestVitals,
  fetchPatients,
  setAlertStatus,
  subscribeToWard,
} from '../lib/supabase'
import { byBedLabel, windowStart, type Bed, type Ward } from './model'

export type WardState = {
  ward: Ward | null
  error: string | null
  /** When the last live update arrived (vitals or alerts). */
  lastUpdate: Date | null
  /** Mark an alert completed or incomplete. */
  setStatus: (alertId: number, status: AlertStatus) => Promise<void>
}

const upsertAlert = (alerts: AlertRow[], row: AlertRow) =>
  alerts.some((a) => a.id === row.id) ? alerts.map((a) => (a.id === row.id ? row : a)) : [...alerts, row]

const withVitals = (ward: Ward, reading: VitalsReading): Ward => ({
  ...ward,
  beds: ward.beds.map((b) => (b.patient.id === reading.patientId ? { ...b, vitals: reading } : b)),
})

async function loadWard(): Promise<Ward> {
  const [encounters, patients, vitals, incomplete, recent] = await Promise.all([
    fetchEncounterRows(),
    fetchPatients(),
    fetchLatestVitals(),
    fetchIncompleteAlerts(),
    fetchAlertsSince(windowStart().toISOString()),
  ])
  const beds: Bed[] = []
  for (const e of encounters) {
    const patient = patients.find((p) => p.id === e.patient_id)
    if (patient) beds.push({ patient, encounterId: e.id, label: e.bed_label, vitals: vitals.find((v) => v.patientId === patient.id) })
  }
  const alerts = [...recent, ...incomplete.filter((o) => !recent.some((t) => t.id === o.id))].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return { beds: beds.sort(byBedLabel), alerts }
}

export function useWard(): WardState {
  const [ward, setWard] = useState<Ward | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      loadWard().then(
        (w) => {
          if (cancelled) return
          setWard(w)
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

    const unsubscribe = subscribeToWard({
      onVitals: (reading) => {
        setWard((w) => (w ? withVitals(w, reading) : w))
        setLastUpdate(new Date())
      },
      onAlert: (row) => {
        setWard((w) => (w ? { ...w, alerts: upsertAlert(w.alerts, row) } : w))
        setLastUpdate(new Date())
      },
      // Deleted rows disappear from the screen immediately…
      onAlertDeleted: (alertId) => {
        setWard((w) => (w ? { ...w, alerts: w.alerts.filter((a) => a.id !== alertId) } : w))
        setLastUpdate(new Date())
        reloadSoon() // …and the rest of the ward is re-synced shortly after.
      },
      onVitalsDeleted: (patientId) => {
        setWard((w) => (w ? { ...w, beds: w.beds.map((b) => (b.patient.id === patientId ? { ...b, vitals: undefined } : b)) } : w))
        setLastUpdate(new Date())
        reloadSoon()
      },
    })
    return () => {
      cancelled = true
      clearTimeout(reloadTimer)
      unsubscribe()
    }
  }, [])

  const setStatus = useCallback(async (alertId: number, status: AlertStatus) => {
    // Optimistic: update the screen right away; Realtime then delivers the saved row
    // (with the database's own completed_at).
    let previous: AlertRow | undefined
    setWard((w) => {
      if (!w) return w
      previous = w.alerts.find((a) => a.id === alertId)
      const completedAt = status === 'completed' ? new Date().toISOString() : null
      return { ...w, alerts: w.alerts.map((a) => (a.id === alertId ? { ...a, status, completed_at: completedAt } : a)) }
    })
    try {
      await setAlertStatus(alertId, status)
    } catch (err) {
      setWard((w) => w && previous ? { ...w, alerts: w.alerts.map((a) => (a.id === alertId ? previous! : a)) } : w)
      throw err
    }
  }, [])

  return { ward, error, lastUpdate, setStatus }
}
