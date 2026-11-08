// Half-circle dial: completed (green) vs incomplete (brown) alerts. Always drawn, even at zero.
import type { AlertRow } from '@repo/shared'
import { alertStats } from '../data/model'
import { Card } from './common'

const ARC = 'M20 100 A80 80 0 0 1 180 100'
const ARC_LENGTH = Math.PI * 80

export function CompletionDial({ alerts, title = 'Last 24 hours' }: { alerts: AlertRow[]; title?: string }) {
  const s = alertStats(alerts)
  const completedLen = s.total ? (s.completed / s.total) * ARC_LENGTH : 0
  const gap = s.completed && s.incomplete ? 3 : 0 // thin gap where the two colors meet

  return (
    <Card title={title}>
      <div className="gauge">
        <svg viewBox="0 0 200 110" role="img" aria-label={`${s.completed} completed, ${s.incomplete} incomplete`}>
          <path d={ARC} className={s.total ? 'gauge-incomplete' : 'gauge-empty'} />
          {s.completed > 0 && (
            <path d={ARC} className="gauge-completed" strokeDasharray={`${Math.max(0, completedLen - gap / 2)} ${ARC_LENGTH}`} />
          )}
          {gap > 0 && <path d={ARC} className="gauge-gap" strokeDasharray={`0 ${completedLen - gap / 2} ${gap} ${ARC_LENGTH}`} />}
        </svg>
        <div className="gauge-label">
          <strong>{s.total}</strong>
          <span>{s.total === 1 ? 'alert' : 'alerts'}</span>
        </div>
      </div>
      <div className="legend legend-center">
        <span><i className="dot dot-ok" /><b>{s.completed}</b> Completed</span>
        <span><i className="dot dot-accent" /><b>{s.incomplete}</b> Incomplete</span>
      </div>
    </Card>
  )
}
