import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { getSession, onAuthChange, signOut, supabaseConfigured } from './lib/supabase'
import { isIncomplete } from './data/model'
import { useWard } from './data/useWard'
import { BellIcon, HistoryIcon, UsersIcon } from './ui/Icons'
import { AlertsPage } from './pages/AlertsPage'
import { PatientsPage } from './pages/PatientsPage'
import { ActivityPage } from './pages/ActivityPage'
import { LoginPage } from './pages/LoginPage'

type Page = 'alerts' | 'patients' | 'activity'
const PAGES: Page[] = ['alerts', 'patients', 'activity']

// The URL hash keeps the current page across reloads: #/alerts, #/patients, #/activity
const pageFromHash = (): Page => {
  const p = window.location.hash.replace(/^#\/?/, '').split('/')[0] as Page
  return PAGES.includes(p) ? p : 'alerts'
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authChecked, setAuthChecked] = useState(!supabaseConfigured)

  useEffect(() => {
    if (!supabaseConfigured) return
    void getSession().then((s) => {
      setSession(s)
      setAuthChecked(true)
    })
    return onAuthChange(setSession)
  }, [])

  if (!authChecked) return <div className="loading">Loading…</div>
  if (!session) return <LoginPage />
  return <Dashboard email={session.user.email ?? 'Signed in'} />
}

function Dashboard({ email }: { email: string }) {
  const { ward, error, lastUpdate, setStatus } = useWard()
  const [page, setPage] = useState<Page>(pageFromHash)
  const [selectedPatient, setSelectedPatient] = useState<string | null>(null)

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (p: Page) => {
    window.location.hash = `/${p}`
    setPage(p)
  }
  const openPatient = (id: string) => {
    setSelectedPatient(id)
    go('patients')
  }

  const incompleteCount = ward?.alerts.filter(isIncomplete).length ?? 0
  const nav: { page: Page; label: string; icon: ReactNode; badge?: number }[] = [
    { page: 'alerts', label: 'Alerts', icon: <BellIcon />, badge: incompleteCount },
    { page: 'patients', label: 'Patients', icon: <UsersIcon /> },
    { page: 'activity', label: 'Activity', icon: <HistoryIcon /> },
  ]

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">SAPPY</div>
        <nav>
          {nav.map((n) => (
            <button key={n.page} className={`nav-item ${page === n.page ? 'active' : ''}`} onClick={() => go(n.page)}>
              {n.icon}
              <span>{n.label}</span>
              {n.badge ? <span className="nav-badge">{n.badge}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="me">
            <span className="avatar">{email.slice(0, 2).toUpperCase()}</span>
            <strong title={email}>{email}</strong>
          </div>
          <p className={`connection ${error ? 'connection-error' : ''}`}>
            <i className="dot" />
            {error ? 'Connection problem' : lastUpdate ? `Live · updated ${lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Connecting…'}
          </p>
          <button className="sign-out" onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>

      <main className="content">
        {error && <div className="error-banner">Couldn't load ward data: {error}</div>}
        {!ward ? (
          !error && <div className="loading">Loading ward…</div>
        ) : page === 'alerts' ? (
          <AlertsPage ward={ward} setStatus={setStatus} openPatient={openPatient} />
        ) : page === 'patients' ? (
          <PatientsPage ward={ward} selectedId={selectedPatient} select={setSelectedPatient} />
        ) : (
          <ActivityPage ward={ward} openPatient={openPatient} />
        )}
      </main>
    </div>
  )
}
