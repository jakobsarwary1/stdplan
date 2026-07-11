'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button, Card, Field, Input } from '@/components/ui'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)
    if (authError) {
      setError('Anmeldung fehlgeschlagen. Bitte E-Mail und Passwort prüfen.')
      return
    }

    router.push('/')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold">FleetOS</h1>
        <p className="mb-6 text-sm text-textMuted">Anmeldung für Unternehmen und Administratoren</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="E-Mail">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Passwort">
            <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" className="w-full justify-center" disabled={loading}>
            {loading ? 'Anmeldung läuft…' : 'Anmelden'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
