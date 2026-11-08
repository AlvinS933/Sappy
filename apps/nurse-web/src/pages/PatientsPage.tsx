import { useState } from 'react'
import type { VitalsReading } from '@repo/shared'
import {
  alertReasons,
  alertTitle,
  byBedLabel,
  byPriority,
  clock,
  duration,
  isIncomplete,
  minutesBetween,
  incompleteTier,
  patientSummary,
  SEX_LABEL,
  shortId,
  timeOfDay,
  TIER,
  type Bed,
  type Ward,
} from '../data/model'
import { Card, Chip, Segmented, StatusChip } from '../ui/common'
import { useNow } from '../ui/useNow'

const CONSCIOUSNESS: Record<string, string> = { A: 'Alert', C: 'New confusion', V: 'Responds to voice', P: 'Responds to pain', U: 'Unresponsive' }

export function PatientsPage({ ward, selectedId, select }: { ward: Ward; selectedId: string | null; select: (id: string) => void }) {
  const [query, setQuery] = useState('')
  // Beds with the most severe open alert first, then by bed label.
  const ranked = [...ward.beds].sort((a, b) => {
    const ta = incompleteTier(ward, a), tb = incompleteTier(ward, b)
    return (tb ? TIER[tb].rank : 0) - (ta ? TIER[ta].rank : 0) || byBedLabel(a, b)
  })
  const q = query.trim().toLowerCase()
  const list = q
    ? ranked.filter((b) => [b.label, patientSummary(b.patient), b.patient.id, ...(b.patient.conditions ?? [])].some((s) => s.toLowerCase().includes(q)))
    : ranked
  const selected = ward.beds.find((b) => b.patient.id === selectedId) ?? ranked[0]

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Patients</h1>
          <p className="subtitle">{ward.beds.length} occupied beds</p>
        </div>
        <input className="search" type="search" placeholder="Search bed, age, condition or id" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>

      {ward.beds.length === 0 ? (
        <p className="empty">No in-progress encounters.</p>
      ) : (
        <div className="grid grid-patients">
          <Card title="Beds" aside="Incomplete alerts first" className="span-rows">
            <ul className="patient-list">
              {list.map((bed) => {
                const tier = incompleteTier(ward, bed)
                return (
                  <li key={bed.encounterId}>
                    <button className={`patient-row ${bed === selected ? 'selected' : ''}`} onClick={() => select(bed.patient.id)}>
                      <span className="bed-square">{bed.label}</span>
                      <span className="request-main">
                        <strong>{patientSummary(bed.patient)}</strong>
                        <small>{shortId(bed.patient)} · {bed.patient.conditions?.[0] ?? 'No active conditions'}</small>
                      </span>
                      {tier && <Chip tone={TIER[tier].className}>{TIER[tier].label}</Chip>}
                    </button>
                  </li>
                )
              })}
              {list.length === 0 && <p className="empty">No beds match “{query}”.</p>}
            </ul>
          </Card>

          {selected && <PatientDetail ward={ward} bed={selected} />}
        </div>
      )}
    </>
  )
}

function PatientDetail({ ward, bed }: { ward: Ward; bed: Bed }) {
  const now = useNow()
  const [range, setRange] = useState<'incomplete' | 'all'>('all')
  const alerts = ward.alerts.filter((a) => a.patient_id === bed.patient.id)
  const open = alerts.filter(isIncomplete).sort(byPriority)
  const top = open[0]
  const history = [...alerts].reverse().filter((a) => range === 'all' || isIncomplete(a))
  const p = bed.patient

  return (
    <>
      <section className="card patient-header">
        <div className={`featured-bed ${top ? `bed-${TIER[top.tier].className}` : 'bed-calm'}`}>
          <span className="featured-bed-label">{bed.label}</span>
          <span className="featured-bed-caption">BED</span>
        </div>
        <div className="patient-header-body">
          <h2>Patient {shortId(p)}</h2>
          <p>{p.ageBand} · {SEX_LABEL[p.gender ?? 'unknown']}</p>
          <p className="muted">Pseudonymous id {p.id}</p>
        </div>
        {top && (
          <Chip tone={TIER[top.tier].className}>
            {TIER[top.tier].label} · waiting {clock(top.created_at, now)}
          </Chip>
        )}
      </section>
      <Card
        title="Alerts"
        aside={
          <Segmented<'incomplete' | 'all'>
            value={range}
            onChange={setRange}
            options={[
              { value: 'incomplete', label: `Incomplete ${open.length}` },
              { value: 'all', label: `All ${alerts.length}` },
            ]}
          />
        }
        className="span-2"
      >
        {history.length === 0 && <p className="empty">{range === 'incomplete' ? 'No incomplete alerts.' : 'No alerts in the last 24 hours.'}</p>}
        <ul className="history-list">
          {history.map((a) => (
            <li key={a.id}>
              <span className="log-time">{timeOfDay(a.created_at)}</span>
              <i className={`dot dot-${a.status === 'completed' ? 'ok' : TIER[a.tier].className}`} />
              <span className="request-main">
                <strong>{alertTitle(a)}</strong>
                <small>
                  {[a.news2_score !== null && `NEWS2 ${a.news2_score}`, alertReasons(a).slice(1).join(' · ')].filter(Boolean).join(' · ')}
                </small>
              </span>
              <span className="request-meta">
                <StatusChip alert={a} />
                <small>
                  {a.completed_at ? `after ${duration(minutesBetween(a.created_at, a.completed_at))}` : `waiting ${duration(minutesBetween(a.created_at, now))}`}
                </small>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Latest vitals" aside={bed.vitals ? `Recorded ${timeOfDay(bed.vitals.recordedAt)}` : undefined}>
        {bed.vitals ? <VitalsGrid v={bed.vitals} /> : <p className="empty">No reading yet.</p>}
      </Card>

      <Card title="Conditions & medications">
        <h3 className="subhead subhead-first">Active conditions</h3>
        <div className="condition-chips">
          {p.conditions?.length ? p.conditions.map((c) => <Chip key={c} tone="muted">{c}</Chip>) : <span className="muted">None recorded</span>}
        </div>
        <h3 className="subhead">Active medications ({p.medications?.length ?? 0})</h3>
        {p.medications?.length ? (
          <ul className="med-list">
            {p.medications.map((m) => <li key={m}>{m}</li>)}
          </ul>
        ) : (
          <span className="muted">None recorded</span>
        )}
      </Card>

      
    </>
  )
}

function VitalsGrid({ v }: { v: VitalsReading }) {
  const rows: [string, string][] = [
    ['Heart rate', v.heartRateBpm !== undefined ? `${v.heartRateBpm} bpm` : '–'],
    ['Blood pressure', v.systolicMmHg !== undefined ? `${v.systolicMmHg}/${v.diastolicMmHg ?? '–'} mmHg` : '–'],
    ['Respiratory rate', v.respiratoryRate !== undefined ? `${v.respiratoryRate} /min` : '–'],
    ['SpO₂', v.spo2Percent !== undefined ? `${v.spo2Percent}%${v.onOxygen === undefined ? '' : v.onOxygen ? ' on O₂' : ' room air'}` : '–'],
    ['Temperature', v.temperatureC !== undefined ? `${v.temperatureC.toFixed(1)} °C` : '–'],
    ['Consciousness', v.consciousness ? CONSCIOUSNESS[v.consciousness] : '–'],
  ]
  return (
    <dl className="vitals-grid">
      {rows.map(([k, val]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{val}</dd>
        </div>
      ))}
    </dl>
  )
}
