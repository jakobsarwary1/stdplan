import Link from 'next/link'
import { requireSuperAdmin } from '@/lib/auth'
import { Button, Card, Field, Input } from '@/components/ui'
import { createCompany } from '../../actions'

export default async function NewCompanyPage() {
  await requireSuperAdmin()

  return (
    <div className="mx-auto max-w-lg">
      <Link href="/admin" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>
      <Card>
        <h1 className="mb-6 text-xl font-semibold">Neues Unternehmen anlegen</h1>
        <form action={createCompany} className="space-y-4">
          <Field label="Name des Unternehmens">
            <Input name="name" required autoFocus />
          </Field>
          <Field label="Adresse (optional)">
            <Input name="address" />
          </Field>
          <Field label="Steuernummer / USt-IdNr. (optional)">
            <Input name="taxId" />
          </Field>
          <Button type="submit" className="w-full justify-center">
            Unternehmen anlegen
          </Button>
        </form>
      </Card>
    </div>
  )
}
