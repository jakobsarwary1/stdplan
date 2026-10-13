import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Button, Card, Field, Input } from '@/components/ui'
import { AddressFields } from '@/components/AddressFields'
import { stripEmployeeNumberPadding } from '@/lib/employeeNumber'
import {
  deleteDriver,
  updateDriverBeschaeftigung,
  updateDriverPersoenlich
} from '../actions'

const TABS = [
  { key: 'persoenlich', label: 'Persönliche Daten' },
  { key: 'beschaeftigung', label: 'Beschäftigung' }
] as const

const EMPLOYMENT_TYPES = [
  { value: 'fulltime', label: 'Vollzeit' },
  { value: 'parttime', label: 'Teilzeit' },
  { value: 'minijob', label: 'Minijob (geringfügige Beschäftigung)' },
  { value: 'shortterm', label: 'Kurzfristige Beschäftigung' },
  { value: 'workingStudent', label: 'Werkstudent' },
  { value: 'auxiliary', label: 'Aushilfe' },
  { value: 'freelancer', label: 'Freelancer / Selbstständig' }
]

function toDateInput(d: Date | null) {
  return d ? d.toISOString().slice(0, 10) : ''
}

export default async function DriverDetailPage({
  params,
  searchParams
}: {
  params: { id: string }
  searchParams: { tab?: string; saved?: string }
}) {
  const user = await requireCompanyUser()
  const activeTab = TABS.find((t) => t.key === searchParams.tab)?.key ?? 'persoenlich'
  const justSaved = searchParams.saved === '1'

  const driver = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driver.findUnique({ where: { id: params.id } })
  )

  if (!driver) notFound()

  const updatePersoenlich = updateDriverPersoenlich.bind(null, driver.id)
  const updateBeschaeftigung = updateDriverBeschaeftigung.bind(null, driver.id)
  const removeDriver = deleteDriver.bind(null, driver.id)

  return (
    <div>
      <Link href="/fahrer" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>

      {justSaved && (
        <div className="mb-4 rounded-lg border border-success/40 bg-success/10 px-4 py-2 text-sm text-success">
          ✓ Gespeichert
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{driver.firstName} {driver.lastName}</h1>
        <form action={removeDriver}>
          <Button variant="ghost" type="submit" className="text-danger">
            Fahrer löschen
          </Button>
        </form>
      </div>

      <div className="mb-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/fahrer/${driver.id}?tab=${t.key}`}
            className={`border-b-2 px-4 py-2 text-sm ${
              activeTab === t.key ? 'border-accent text-text' : 'border-transparent text-textMuted hover:text-text'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {activeTab === 'persoenlich' && (
        <Card className="max-w-xl">
          <form action={updatePersoenlich} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Vorname">
                <Input name="firstName" defaultValue={driver.firstName} required />
              </Field>
              <Field label="Nachname">
                <Input name="lastName" defaultValue={driver.lastName} required />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Geburtsdatum">
                <Input name="birthDate" type="date" defaultValue={toDateInput(driver.birthDate)} />
              </Field>
              <Field label="Geburtsort">
                <Input name="birthPlace" defaultValue={driver.birthPlace ?? ''} />
              </Field>
            </div>
            <Field label="Telefonnummer">
              <Input name="phone" defaultValue={driver.phone ?? ''} />
            </Field>
            <Field label="E-Mail">
              <Input name="email" type="email" defaultValue={driver.email ?? ''} />
            </Field>
            <AddressFields
              defaultStreet={driver.street ?? ''}
              defaultHouseNumber={driver.houseNumber ?? ''}
              defaultPostalCode={driver.postalCode ?? ''}
              defaultCity={driver.city ?? ''}
            />
            <Button type="submit">Speichern</Button>
          </form>
        </Card>
      )}

      {activeTab === 'beschaeftigung' && (
        <Card className="max-w-xl">
          <form action={updateBeschaeftigung} className="space-y-4">
            <div className="field">
              <label className="label">Beschäftigungsart</label>
              <select name="employmentType" defaultValue={driver.employmentType} className="input">
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">Status</label>
              <select name="status" defaultValue={driver.status} className="input">
                <option value="active">Aktiv</option>
                <option value="inactive">Inaktiv</option>
                <option value="terminated">Gekündigt</option>
              </select>
            </div>
            <Field label="Personalnummer">
              <Input name="employeeNumber" defaultValue={stripEmployeeNumberPadding(driver.employeeNumber)} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Eintritt">
                <Input name="hireDate" type="date" defaultValue={toDateInput(driver.hireDate)} />
              </Field>
              <Field label="SV-Nummer">
                <Input name="socialSecurityNumber" defaultValue={driver.socialSecurityNumber ?? ''} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Kasse">
                <Input name="healthInsuranceProvider" defaultValue={driver.healthInsuranceProvider ?? ''} placeholder="z. B. AOK, TK, Barmer" />
              </Field>
              <Field label="Steuer-ID Nr.">
                <Input name="taxId" defaultValue={driver.taxId ?? ''} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Führerscheinklasse">
                <Input name="licenseClass" defaultValue={driver.licenseClass ?? ''} placeholder="B" />
              </Field>
              <Field label="Führerscheinnummer">
                <Input name="licenseNumber" defaultValue={driver.licenseNumber ?? ''} style={{ textTransform: 'uppercase' }} />
              </Field>
            </div>
            <Field label="Führerschein gültig bis">
              <Input name="licenseExpiry" type="date" defaultValue={toDateInput(driver.licenseExpiry)} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Personenbeförderungsschein Nr.">
                <Input name="pbeScheinNumber" defaultValue={driver.pbeScheinNumber ?? ''} />
              </Field>
              <Field label="P-Schein gültig bis">
                <Input name="pbeScheinExpiry" type="date" defaultValue={toDateInput(driver.pbeScheinExpiry)} />
              </Field>
            </div>
            <Field label="Stundenlohn (€, optional – für Bruttolohn-Schätzung im Dienstplan)">
              <Input
                name="hourlyRate"
                type="text"
                inputMode="decimal"
                defaultValue={driver.hourlyRate != null ? String(driver.hourlyRate).replace('.', ',') : ''}
                placeholder="z. B. 13,90"
              />
              <p className="mt-1 text-xs text-textMuted">Zwischen 13,90 € (gesetzlicher Mindestlohn 2026) und 30,00 €. Komma oder Punkt möglich.</p>
            </Field>
            <Button type="submit">Speichern</Button>
          </form>
        </Card>
      )}

    </div>
  )
}
