import Link from 'next/link'
import { requireCompanyUser } from '@/lib/auth'
import { Button, Card, Field, Input } from '@/components/ui'
import { createDriver } from '../actions'

export default async function NewDriverPage() {
  await requireCompanyUser()

  return (
    <div className="mx-auto max-w-lg">
      <Link href="/fahrer" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>
      <Card>
        <h1 className="mb-6 text-xl font-semibold">Fahrer erfassen</h1>
        <form action={createDriver} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Vorname">
              <Input name="firstName" required autoFocus />
            </Field>
            <Field label="Nachname">
              <Input name="lastName" required />
            </Field>
          </div>
          <Field label="Telefonnummer (optional)">
            <Input name="phone" />
          </Field>
          <Field label="E-Mail (optional)">
            <Input name="email" type="email" />
          </Field>
          <Button type="submit" className="w-full justify-center">
            Fahrer anlegen
          </Button>
        </form>
        <p className="mt-4 text-xs text-textMuted">
          Weitere Angaben (Beschäftigung, Dokumente, Qualifikationen) können nach dem Anlegen im Fahrerprofil
          ergänzt werden.
        </p>
      </Card>
    </div>
  )
}
