import Link from 'next/link'
import { requireCompanyUser } from '@/lib/auth'
import { Button, Card, Field, Input } from '@/components/ui'
import { createShiftTemplate } from '../actions'

export default async function NewShiftTemplatePage() {
  await requireCompanyUser()

  return (
    <div className="mx-auto max-w-lg">
      <Link href="/schichtmodelle" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>
      <Card>
        <h1 className="mb-6 text-xl font-semibold">Schichtmodell erstellen</h1>
        <form action={createShiftTemplate} className="space-y-4">
          <Field label="Name">
            <Input name="name" required autoFocus placeholder="z. B. Einzelfahrer" />
          </Field>
          <Field label="Beschreibung (optional)">
            <Input name="description" />
          </Field>
          <Button type="submit" className="w-full justify-center">
            Erstellen
          </Button>
        </form>
        <p className="mt-4 text-xs text-textMuted">
          Einzelne Schichten (Startfenster, Netto-Arbeitszeit, Planungsverhalten) werden danach im Modell
          ergänzt.
        </p>
      </Card>
    </div>
  )
}
