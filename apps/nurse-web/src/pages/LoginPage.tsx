import { useState, type FormEvent } from 'react'
import { signIn, supabaseConfigured } from '../lib/supabase'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="brand brand-dark">SAPPY</div>
        <h1>Nurse sign in</h1>
        {supabaseConfigured ? (
          <form onSubmit={submit}>
            <label>
              Email
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        ) : (
          <p className="body-text">
            Supabase isn't configured for this app. Copy <code>apps/nurse-web/.env.example</code> to <code>apps/nurse-web/.env</code> and fill in
            the URL and publishable key to see live data.
          </p>
        )}
      </div>
    </main>
  )
}
