import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Card } from '@/components/ui'
import { ConfirmationToggle } from './ConfirmationToggle'
import type { ConfirmationField } from './actions'

// Kern-Dokumente, die für jeden aktiven Fahrer vorhanden sein sollten.
// (Sonstiges/optionale Zusatzdokumente wie "A-Fragebogen Angestellte" oder
// "Sonstiges" zählen bewusst nicht als Pflicht-Dokument für diese Übersicht.)
const REQUIRED_DOCUMENT_TYPES = [
  'Arbeitsvertrag',
  'Führerschein',
  'Personenbeförderungsschein',
  'Personalausweis / Aufenthaltstitel'
]

const CONFIRMATION_FIELDS: { field: ConfirmationField; label: string; short: string }[] = [
  { field: 'tipsConfirmed', label: 'Trinkgeld-Bestätigung', short: 'Trinkgeld' },
  { field: 'expensesConfirmed', label: 'Spesen-Bestätigung (falls ausgezahlt)', short: 'Spesen' },
  { field: 'timesheetConfirmed', label: 'Stundenzettel', short: 'Stundenzettel' },
  { field: 'cashWageConfirmed', label: 'Lohnbestätigung (falls bar ausgezahlt)', short: 'Lohn (bar)' }
]

export default async function DashboardPage({
  searchParams
}: {
  searchParams: { year?: string; month?: string }
}) {
  const user = await requireCompanyUser()

  const today = new Date()
  const year = parseInt(searchParams.year ?? '', 10) || today.getFullYear()
  const month = parseInt(searchParams.month ?? '', 10) || today.getMonth() + 1 // 1-12
  const monthLabel = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1))

  const [vehicleCount, driverCount, drivers, confirmations] = await withTenantContext(
    { companyId: user.companyId, isSuperAdmin: false },
    async (tx) => [
      await tx.vehicle.count(),
      await tx.driver.count(),
      await tx.driver.findMany({
        where: { status: 'active' },
        select: { id: true, firstName: true, lastName: true, documents: { select: { type: true } } },
        orderBy: { firstName: 'asc' }
      }),
      await tx.driverMonthlyConfirmation.findMany({
        where: { year, month }
      })
    ]
  )

  const driversWithMissingDocs = drivers
    .map((d) => {
      const existingTypes = new Set(d.documents.map((doc) => doc.type))
      const missing = REQUIRED_DOCUMENT_TYPES.filter((t) => !existingTypes.has(t))
      return { id: d.id, name: `${d.firstName} ${d.lastName}`, missing }
    })
    .filter((d) => d.missing.length > 0)

  const confirmationByDriverId = new Map(confirmations.map((c) => [c.driverId, c]))

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Übersicht</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <Card>
          <p className="text-xs uppercase text-textMuted">Fahrzeuge</p>
          <p className="mt-2 text-2xl font-semibold">{vehicleCount}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-textMuted">Fahrer</p>
          <p className="mt-2 text-2xl font-semibold">{driverCount}</p>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Fehlende Dokumente</h2>
      {driversWithMissingDocs.length === 0 ? (
        <Card><p className="text-sm text-textMuted">Bei allen aktiven Fahrern liegen alle Kern-Dokumente vor.</p></Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surfaceAlt text-left text-xs uppercase text-textMuted">
              <tr>
                <th className="px-4 py-3">Fahrer</th>
                <th className="px-4 py-3">Fehlende Dokumente</th>
              </tr>
            </thead>
            <tbody>
              {driversWithMissingDocs.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium">
                    <a href={`/fahrer/${d.id}?tab=dokumente`} className="hover:underline">{d.name}</a>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {d.missing.map((m) => (
                        <span key={m} className="rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 text-xs text-danger">
                          {m}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 mt-8 flex items-center justify-between text-lg font-semibold">
        <span>Monatliche Bestätigungen – {monthLabel}</span>
        <span className="flex gap-3 text-sm font-normal">
          <a href={`/dashboard?year=${month === 1 ? year - 1 : year}&month=${month === 1 ? 12 : month - 1}`} className="text-textMuted hover:underline">← Vorheriger Monat</a>
          <a href={`/dashboard?year=${month === 12 ? year + 1 : year}&month=${month === 12 ? 1 : month + 1}`} className="text-textMuted hover:underline">Nächster Monat →</a>
        </span>
      </h2>
      <p className="mb-3 text-xs text-textMuted">
        Für jeden Fahrer muss monatlich bestätigt werden: Trinkgeld, Spesen (falls ausgezahlt), Stundenzettel, Lohnbestätigung (falls bar ausgezahlt).
      </p>
      {drivers.length === 0 ? (
        <Card><p className="text-sm text-textMuted">Keine aktiven Fahrer vorhanden.</p></Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surfaceAlt text-left text-xs uppercase text-textMuted">
              <tr>
                <th className="px-4 py-3">Fahrer</th>
                {CONFIRMATION_FIELDS.map((f) => (
                  <th key={f.field} className="px-4 py-3 text-center">{f.short}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => {
                const confirmation = confirmationByDriverId.get(d.id)
                return (
                  <tr key={d.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">{d.firstName} {d.lastName}</td>
                    {CONFIRMATION_FIELDS.map((f) => (
                      <td key={f.field} className="px-4 py-3 text-center">
                        <div className="flex justify-center">
                          <ConfirmationToggle
                            driverId={d.id}
                            year={year}
                            month={month}
                            field={f.field}
                            checked={confirmation?.[f.field] ?? false}
                            label={f.label}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
