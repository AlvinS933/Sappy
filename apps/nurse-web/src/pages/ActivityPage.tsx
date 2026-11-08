import { useState } from 'react'
import {
  alertStats,
  bedForAlert,
  duration,
  hourLabel,
  isIncomplete,
  inScope,
  minutesBetween,
  responseByHour,
  timeOfDay,
  type Ward,
  type WardAlert,
} from '../data/model'
import { Card, Segmented, StatusChip } from '../ui/common'
import { CompletionDial } from '../ui/CompletionDial'
import { useNow } from '../ui/useNow'

type Filter = 'all' | 'completed' | 'incomplete' | 'go now'

export function ActivityPage({ ward, openPatient }: { ward: Ward; openPatient: (id: string) => void }) {
  const now = useNow(30_000)
  const [filter, setFilter] = useState<Filter>('all')
  const scoped = ward.alerts.filter((a) => inScope(a, now))
  const s = alertStats(scoped)
  const shown = [...scoped]
    .reverse()
    .filter((a) => (filter === 'completed' ? !isIncomplete(a) : filter === 'incomplete' ? isIncomplete(a) : filter === 'go now' ? a.tier === 'go now' : true))

  // Group by clock hour.
  const groups: { hour: number; alerts: WardAlert[] }[] = []
  for (const a of shown) {
    const hour = new Date(a.created_at).getHours()
    const last = groups.at(-1)
    if (last?.hour === hour) last.alerts.push(a)
    else groups.push({ hour, alerts: [a] })
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Activity</h1>
          <p className="subtitle">NEWS2 alerts and patient requests from the last 24 hours, plus any still incomplete</p>
        </div>
      </header>

      <div className="grid grid-activity">
        <Card>
          <div className="card-toolbar">
            <Segmented<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `All ${s.total}` },
                { value: 'completed', label: `Completed ${s.completed}` },
                { value: 'incomplete', label: `Incomplete ${s.incomplete}` },
                { value: 'go now', label: `Go now ${s.goNow}` },
              ]}
            />
            <span className="card-aside">Newest first</span>
          </div>

          {groups.length === 0 && <p className="empty">No alerts {filter === 'all' ? 'in the last 24 hours' : 'match this filter'}.</p>}
          {groups.map((g) => (
            <div key={`${g.hour}-${g.alerts[0].id}`} className="log-group">
              <div className="log-hour">{hourLabel(g.hour)}</div>
              <ul className="log-list">
                {g.alerts.map((a) => {
                  const bed = bedForAlert(ward, a)
                  const doneIn = a.completed_at ? minutesBetween(a.created_at, a.completed_at) : null
                  return (
                    <li key={a.key}>
                      <button className="log-row" onClick={() => openPatient(a.patient_id)}>
                        <span className="log-time">{timeOfDay(a.created_at)}</span>
                        <span className="bed-circle">{bed?.label ?? '—'}</span>
                        <span className="request-main">
                          <strong>{a.title}</strong>
                          <small>
                            {a.tag} · 
                            {doneIn !== null ? `completed ${timeOfDay(a.completed_at!)}` : 'incomplete'}
                          </small>
                        </span>
                        <span className="request-meta">
                          <StatusChip alert={a} />
                          <small>{doneIn !== null ? duration(doneIn) : `waiting ${duration(minutesBetween(a.created_at, now))}`}</small>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </Card>

        <div className="side-stack">
          <CompletionDial alerts={scoped} />
          <ResponseChart alerts={scoped} avg={s.avgResponse} />
          <AlertsByBed ward={ward} alerts={scoped} openPatient={openPatient} />
        </div>
      </div>
    </>
  )
}

function ResponseChart({ alerts, avg }: { alerts: WardAlert[]; avg: number | null }) {
  const hours = responseByHour(alerts)
  const max = Math.max(1, ...hours.map((h) => h.avg))
  return (
    <Card
      title={
        <span className="title-with-sub">
          Time to complete<small>Average, by hour the alert was created</small>
        </span>
      }
      aside={<span className="big-number">{avg === null ? '–' : duration(avg)}</span>}
    >
      {hours.length === 0 ? (
        <p className="empty">No completed alerts in the last 24 hours.</p>
      ) : (
        <div className="bar-chart">
          {hours.map((h) => (
            <div key={h.hour} className="bar-col">
              <span className="bar-value">{duration(h.avg)}</span>
              <div className="bar" style={{ height: `${(h.avg / max) * 100}%` }} />
              <span className="bar-label">{hourLabel(h.hour)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function AlertsByBed({ ward, alerts, openPatient }: { ward: Ward; alerts: WardAlert[]; openPatient: (id: string) => void }) {
  const counts = ward.beds
    .map((bed) => ({ bed, n: alerts.filter((a) => a.patient_id === bed.patient.id).length }))
    .sort((a, b) => b.n - a.n)
  const max = Math.max(1, ...counts.map((c) => c.n))
  return (
    <Card title="Alerts by bed" aside="Last 24 hours">
      {counts.length === 0 ? (
        <p className="empty">No occupied beds.</p>
      ) : (
        <ul className="hbar-list">
          {counts.map(({ bed, n }) => (
            <li key={bed.encounterId}>
              <button onClick={() => openPatient(bed.patient.id)}>
                <span className="bed-circle bed-circle-sm">{bed.label}</span>
                <span className="hbar-track"><span className="hbar" style={{ width: `${(n / max) * 100}%` }} /></span>
                <b>{n}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
