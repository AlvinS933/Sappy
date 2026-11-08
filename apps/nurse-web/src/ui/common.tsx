// Small shared UI pieces.
import type { ReactNode } from 'react'
import { TIER, type WardAlert } from '../data/model'

export function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>
}

/** "Completed", or the tier (Go now / Check soon / Watch) while the alert is incomplete. */
export function StatusChip({ alert }: { alert: WardAlert }) {
  if (alert.status === 'completed') return <Chip tone="ok">Completed</Chip>
  const t = TIER[alert.tier]
  return <Chip tone={t.className}>{t.label}</Chip>
}

/** Where an item came from: the NEWS2 score, or the patient's bedside app. */
export function SourceTag({ alert }: { alert: WardAlert }) {
  return <span className={`source-tag source-${alert.origin}`}>{alert.tag}</span>
}

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || aside) && (
        <header className="card-header">
          {title && <h2>{title}</h2>}
          {aside && <span className="card-aside">{aside}</span>}
        </header>
      )}
      {children}
    </section>
  )
}

/** Segmented filter control. */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
