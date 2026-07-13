import Link from 'next/link'
import { requireCompanyUser } from '@/lib/auth'
import { Button, Card, Field, Input } from '@/components/ui'
import { createVehicle } from '../actions'

export default async function NewVehiclePage() {
  await requireCompanyUser()

  return (
    <div className="mx-auto max-w-lg">
      <Link href="/fahrzeuge" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>
      <Card>
        <h1 className="mb-6 text-xl font-semibold">Fahrzeug erfassen</h1>
        <form action={createVehicle} className="space-y-4">
          <Field label="Kennzeichen">
            <Input name="licensePlate" required autoFocus placeholder="K-AB 1234" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Marke">
              <Input name="brand" />
            </Field>
            <Field label="Modell">
              <Input name="model" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Baujahr">
              <Input name="year" type="number" />
            </Field>
            <Field label="Farbe">
              <Input name="color" />
            </Field>
          </div>
          <Field label="Fahrgestellnummer (FIN, optional)">
            <Input name="vin" />
          </Field>
          <Button type="submit" className="w-full justify-center">
            Fahrzeug anlegen
          </Button>
        </form>
        <p className="mt-4 text-xs text-textMuted">
          Weitere Angaben (Besitz &amp; Verträge, Dokumente, Fahrerzuordnung) können nach dem Anlegen im
          Fahrzeugprofil ergänzt werden.
        </p>
      </Card>
    </div>
  )
}
