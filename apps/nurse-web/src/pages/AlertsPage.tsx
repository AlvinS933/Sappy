import { useState } from 'react'
import type { AlertRow, AlertStatus, AlertTier } from '@repo/shared'
import {
  alertReasons,
  alertTitle,
  bedForAlert,
  byPriority,
  clock,
  duration,
  isIncomplete,
  inScope,
  minutesBetween,
  incompleteTier,
  patientSummary,
  shortId,
  TIER,
  type Ward,
} from '../data/model'
import { Card, Segmented, StatusChip } from '../ui/common'
import { CompletionDial } from '../ui/CompletionDial'
import { PulseIcon } from '../ui/Icons'
import { useNow } from '../ui/useNow'

type Filter = 'all' | AlertTier

type Props = {
  ward: Ward
  setStatus: (id: number, status: AlertStatus) => Promise<void>
  openPatient: (patientId: string) => void
}

export function AlertsPage({ ward, setStatus, openPatient }: Props) {
  const now = useNow()
  const [filter, setFilter] = useState<Filter>('all')
  const open = ward.alerts.filter(isIncomplete).sort(byPriority)
  const shown = filter === 'all' ? open : open.filter((a) => a.tier === filter)
  const [top, ...rest] = shown
  const count = (t: Filter) => (t === 'all' ? open : open.filter((a) => a.tier === t)).length

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Alerts</h1>
          <p className="subtitle">
            {ward.beds.length} occupied beds · {open.length} incomplete {open.length === 1 ? 'alert' : 'alerts'}
          </p>
        </div>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${count('all')}` },
            { value: 'go now', label: `Go now ${count('go now')}` },
            { value: 'check soon', label: `Check soon ${count('check soon')}` },
            { value: 'watch', label: `Watch ${count('watch')}` },
          ]}
        />
      </header>

      {top ? (
        <FeaturedAlert alert={top} ward={ward} now={now} setStatus={setStatus} openPatient={openPatient} />
      ) : (
        <div className="featured featured-clear">
          <strong>No incomplete alerts{filter === 'all' ? '' : ` in “${TIER[filter].label}”`}.</strong>
        </div>
      )}

      <div className="grid grid-alerts">
        <Card title="Up next" aside="By tier, then wait time" className="span-rows">
          {rest.length === 0 ? (
            <p className="empty">Nothing else waiting.</p>
          ) : (
            <ul className="request-list">
              {rest.map((a) => (
                <AlertRowItem
                  key={a.id}
                  alert={a}
                  ward={ward}
                  now={now}
                  onOpen={() => openPatient(a.patient_id)}
                  onComplete={() => setStatus(a.id, 'completed')}
                />
              ))}
            </ul>
          )}
        </Card>

        <WardMap ward={ward} openPatient={openPatient} />
        <CompletionDial alerts={ward.alerts.filter((a) => inScope(a, now))} />
      </div>
    </>
  )
}

function FeaturedAlert({ alert, ward, now, setStatus, openPatient }: { alert: AlertRow; ward: Ward; now: Date; setStatus: (id: number, status: AlertStatus) => Promise<void>; openPatient: (id: string) => void }) {
  const bed = bedForAlert(ward, alert)
  const tier = TIER[alert.tier]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const complete = async () => {
    setBusy(true)
    setError(null)
    try {
      await setStatus(alert.id, 'completed')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`featured featured-${tier.className}`} aria-live="assertive">
      <div className="featured-bed">
        <span className="featured-bed-label">{bed?.label ?? '—'}</span>
        <span className="featured-bed-caption">BED</span>
      </div>
      <div className="featured-body">
        <p className="featured-kicker">
          {tier.label.toUpperCase()}
          {bed && ` · ${patientSummary(bed.patient)} · ${shortId(bed.patient)}`}
        </p>
        <h2>{alertTitle(alert)}</h2>
        <p className="featured-detail">{alertReasons(alert).join(' · ')}</p>
        {alert.news2_score !== null && (
          <span className="source-tag">
            <PulseIcon /> NEWS2 score {alert.news2_score}
          </span>
        )}
      </div>
      <div className="featured-wait">
        <span>WAITING</span>
        <strong>{clock(alert.created_at, now)}</strong>
      </div>
      <div className="featured-actions">
        <button className="btn btn-primary" onClick={complete} disabled={busy}>
          {busy ? 'Saving…' : 'Mark complete'}
        </button>
        <button className="btn btn-secondary" onClick={() => openPatient(alert.patient_id)}>
          Patient
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  )
}

function AlertRowItem({ alert, ward, now, onOpen, onComplete }: { alert: AlertRow; ward: Ward; now: Date; onOpen: () => void; onComplete: () => Promise<void> }) {
  const bed = bedForAlert(ward, alert)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const complete = async () => {
    setBusy(true)
    setError(null)
    try {
      await onComplete() // the row disappears from the queue once it's completed
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <li className="request-item">
      <button className="request-row" onClick={onOpen} title="Open patient">
        <span className="bed-circle">{bed?.label ?? '—'}</span>
        <span className="request-main">
          <strong>{alertTitle(alert)}</strong>
          <small>
            {[bed && patientSummary(bed.patient), alert.news2_score !== null && `NEWS2 ${alert.news2_score}`].filter(Boolean).join(' · ')}
          </small>
        </span>
        <span className="request-meta">
          <strong>{duration(minutesBetween(alert.created_at, now))}</strong>
          <StatusChip alert={alert} />
        </span>
      </button>
      <button className="btn-complete" onClick={complete} disabled={busy} aria-label={`Mark ${alertTitle(alert)} complete`}>
        {busy ? 'Saving…' : 'Complete'}
      </button>
      {error && <p className="error request-error">{error}</p>}
    </li>
  )
}

function WardMap({ ward, openPatient }: { ward: Ward; openPatient: (id: string) => void }) {
  return (
    <Card title="Ward" aside={`${ward.beds.length} occupied beds`}>
      {ward.beds.length === 0 ? (
        <p className="empty">No in-progress encounters.</p>
      ) : (
        <div className="unit-row">
          {ward.beds.map((bed) => {
            const tier = incompleteTier(ward, bed)
            return (
              <button
                key={bed.encounterId}
                className={`unit-bed ${tier ? `unit-${TIER[tier].className}` : ''}`}
                title={`${bed.label} · ${patientSummary(bed.patient)}${tier ? ` · ${TIER[tier].label}` : ''}`}
                onClick={() => openPatient(bed.patient.id)}
              >
                {bed.label}
              </button>
            )
          })}
        </div>
      )}
      <div className="legend">
        <span><i className="dot dot-go-now" />Go now</span>
        <span><i className="dot dot-check-soon" />Check soon</span>
        <span><i className="dot dot-watch" />Watch</span>
        <span><i className="dot dot-stable" />No incomplete alerts</span>
      </div>
    </Card>
  )
}
