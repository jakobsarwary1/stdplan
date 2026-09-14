import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Badge, Button, Card, Field, Input } from '@/components/ui'
import {
  addVehicleDriverAssignment,
  deleteVehicle,
  removeVehicleDriverAssignment,
  updateVehicleBesitz,
  updateVehicleStammdaten
} from '../actions'

const TABS = [
  { key: 'stammdaten', label: 'Stammdaten' },
  { key: 'besitz', label: 'Besitz & Verträge' },
  { key: 'fahrer', label: 'Fahrerzuordnung' }
] as const

const DRIVER_ROLES = [
  { value: 'stamm', label: 'Stammfahrer' },
  { value: 'zweit', label: 'Zweitfahrer' },
  { value: 'vertretung', label: 'Vertretungsfahrer' },
  { value: 'minijob', label: 'Minijobber' },
  { value: 'aushilfe', label: 'Aushilfe' },
  { value: 'springer', label: 'Springer' }
]

function fmtDate(d: Date | null) {
  return d ? new Intl.DateTimeFormat('de-DE').format(d) : ''
}

function tuvWarning(tuvUntil: Date | null): string | null {
  if (!tuvUntil) return null
  const now = new Date()
  const maxAllowed = new Date(now.getFullYear(), now.getMonth() + 12, now.getDate())
  if (tuvUntil.getTime() > maxAllowed.getTime()) {
    return '„TÜV gültig bis" liegt mehr als 12 Monate in der Zukunft – nach § 29 StVZO gilt für gewerbliche Mietwagen eine Hauptuntersuchungspflicht von maximal 12 Monaten. Bitte Datum prüfen.'
  }
  return null
}

export default async function VehicleDetailPage({
  params,
  searchParams
}: {
  params: { id: string }
  searchParams: { tab?: string; saved?: string }
}) {
  const user = await requireCompanyUser()
  const activeTab = TABS.find((t) => t.key === searchParams.tab)?.key ?? 'stammdaten'
  const justSaved = searchParams.saved === '1'

  const [vehicle, drivers, shiftTemplates] = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => [
    await tx.vehicle.findUnique({
      where: { id: params.id },
      include: { assignments: { include: { driver: true } } }
    }),
    await tx.driver.findMany({ where: { status: 'active' }, orderBy: { firstName: 'asc' } }),
    await tx.shiftTemplate.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
  ])

  if (!vehicle) notFound()

  const updateStammdaten = updateVehicleStammdaten.bind(null, vehicle.id)
  const updateBesitz = updateVehicleBesitz.bind(null, vehicle.id)
  const removeVehicle = deleteVehicle.bind(null, vehicle.id)
  const addAssignment = addVehicleDriverAssignment.bind(null, vehicle.id)

  const assignedDriverIds = new Set(vehicle.assignments.map((a) => a.driverId))
  const availableDrivers = drivers.filter((d) => !assignedDriverIds.has(d.id))
  const warning = tuvWarning(vehicle.tuvUntil)

  return (
    <div>
      <Link href="/fahrzeuge" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>

      {justSaved && (
        <div className="mb-4 rounded-lg border border-success/40 bg-success/10 px-4 py-2 text-sm text-success">
          ✓ Gespeichert
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{vehicle.licensePlate}</h1>
        <form action={removeVehicle}>
          <Button variant="ghost" type="submit" className="text-danger">
            Fahrzeug löschen
          </Button>
        </form>
      </div>

      <div className="mb-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/fahrzeuge/${vehicle.id}?tab=${t.key}`}
            className={`border-b-2 px-4 py-2 text-sm ${
              activeTab === t.key ? 'border-accent text-text' : 'border-transparent text-textMuted hover:text-text'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {activeTab === 'stammdaten' && (
        <Card className="max-w-xl">
          <form action={updateStammdaten} className="space-y-4">
            <Field label="Kennzeichen">
              <Input name="licensePlate" defaultValue={vehicle.licensePlate} required />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Marke">
                <Input name="brand" defaultValue={vehicle.brand ?? ''} />
              </Field>
              <Field label="Modell">
                <Input name="model" defaultValue={vehicle.model ?? ''} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Baujahr">
                <Input name="year" type="number" defaultValue={vehicle.year ?? ''} />
              </Field>
              <Field label="Farbe">
                <Input name="color" defaultValue={vehicle.color ?? ''} />
              </Field>
            </div>
            <Field label="Fahrgestellnummer (FIN)">
              <Input name="vin" defaultValue={vehicle.vin ?? ''} />
            </Field>
            <Field label="Kilometerstand">
              <Input name="mileage" type="number" defaultValue={vehicle.mileage} />
            </Field>
            <div className="field">
              <label className="label">Status</label>
              <select name="status" defaultValue={vehicle.status} className="input">
                <option value="active">Aktiv</option>
                <option value="workshop">Werkstatt</option>
                <option value="out_of_service">Außer Betrieb</option>
                <option value="sold">Verkauft</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Schichtmodell (Grundlage der Auto-Planung)</label>
              <select name="shiftTemplateId" defaultValue={vehicle.shiftTemplateId ?? ''} className="input">
                <option value="">– keines –</option>
                {shiftTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <Button type="submit">Speichern</Button>
          </form>
        </Card>
      )}

      {activeTab === 'besitz' && (
        <Card className="max-w-xl">
          <h2 className="mb-4 font-semibold">Zulassung</h2>
          <form action={updateBesitz} className="space-y-4">
            <div className="field">
              <label className="label">Besitzart</label>
              <select name="ownershipType" defaultValue={vehicle.ownershipType} className="input">
                <option value="company">Firmeneigentum</option>
                <option value="leasing">Leasing</option>
                <option value="financing">Finanzierung</option>
                <option value="private">Privat</option>
              </select>
            </div>
            <Field label="Zulassungsdatum">
              <Input name="registrationDate" type="date" defaultValue={vehicle.registrationDate?.toISOString().slice(0, 10) ?? ''} />
            </Field>
            <Field label="TÜV gültig bis">
              <Input name="tuvUntil" type="date" defaultValue={vehicle.tuvUntil?.toISOString().slice(0, 10) ?? ''} />
            </Field>
            {warning && (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{warning}</p>
            )}
            <Field label="Mietwagengenehmigungs-Nr. / Konzessions-Nr.">
              <Input name="concessionNumber" defaultValue={vehicle.concessionNumber ?? ''} />
            </Field>
            <Field label="Mietwagengenehmigung gültig bis">
              <Input name="rentalPermitUntil" type="date" defaultValue={vehicle.rentalPermitUntil?.toISOString().slice(0, 10) ?? ''} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Umweltplakette">
                <Input name="envBadge" defaultValue={vehicle.envBadge ?? ''} placeholder="Grün" />
              </Field>
              <Field label="Euronorm">
                <Input name="euroNorm" defaultValue={vehicle.euroNorm ?? ''} placeholder="Euro 6" />
              </Field>
            </div>
            <Button type="submit">Speichern</Button>
          </form>
        </Card>
      )}

      {activeTab === 'fahrer' && (
        <div className="max-w-2xl space-y-6">
          <Card>
            <h2 className="mb-2 font-semibold">Fahrerzuordnung</h2>
            <p className="mb-4 text-sm text-textMuted">
              Es gibt immer nur einen Stammfahrer gleichzeitig – ein neuer Stammfahrer stuft den bisherigen
              automatisch zurück.
            </p>
            {vehicle.assignments.length === 0 ? (
              <p className="mb-4 text-sm text-textMuted">Noch keine Fahrer zugeordnet.</p>
            ) : (
              <table className="mb-4 w-full text-sm">
                <thead className="text-left text-xs uppercase text-textMuted">
                  <tr>
                    <th className="pb-2">Fahrer</th>
                    <th className="pb-2">Rolle</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {vehicle.assignments.map((a) => {
                    const remove = removeVehicleDriverAssignment.bind(null, vehicle.id, a.id)
                    return (
                      <tr key={a.id} className="border-t border-border">
                        <td className="py-2">{a.driver.firstName} {a.driver.lastName}</td>
                        <td className="py-2">
                          <Badge tone={a.role === 'stamm' ? 'success' : 'muted'}>
                            {DRIVER_ROLES.find((r) => r.value === a.role)?.label ?? a.role}
                          </Badge>
                        </td>
                        <td className="py-2 text-right">
                          <form action={remove}>
                            <button type="submit" className="text-xs text-danger hover:underline">Entfernen</button>
                          </form>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {availableDrivers.length === 0 ? (
              <p className="text-xs text-textMuted">Alle aktiven Fahrer sind bereits zugeordnet.</p>
            ) : (
              <form action={addAssignment} className="flex items-end gap-3">
                <div className="field flex-1">
                  <label className="label">Fahrer</label>
                  <select name="driverId" className="input" required>
                    {availableDrivers.map((d) => (
                      <option key={d.id} value={d.id}>{d.firstName} {d.lastName}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label">Rolle</label>
                  <select name="role" className="input" defaultValue="zweit">
                    {DRIVER_ROLES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <Button type="submit">Zuordnen</Button>
              </form>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
