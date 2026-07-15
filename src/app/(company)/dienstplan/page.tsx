import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Card } from '@/components/ui'
import { AutoPlanningForm } from './AutoPlanningForm'
import { HoursPlanningForm } from './HoursPlanningForm'
import { MonthCalendar } from './MonthCalendar'
import { DeleteMonthButton } from './DeleteMonthButton'
import { deleteDriverMonthShifts, deleteAllMonthShifts } from './actions'
import { fmtDateDEWithWeekday, formatBreakRanges } from '@/lib/planning/format'
import { stripEmployeeNumberPadding } from '@/lib/employeeNumber'

function dateToStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function clockToMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

export default async function DienstplanPage({
  searchParams
}: {
  searchParams: { year?: string; month?: string }
}) {
  const user = await requireCompanyUser()

  const today = new Date()
  const year = parseInt(searchParams.year ?? '', 10) || today.getFullYear()
  const month = parseInt(searchParams.month ?? '', 10) || today.getMonth() + 1 // 1-12

  const monthStart = new Date(year, month - 1, 1)
  const monthEnd = new Date(year, month, 0)

  const [vehicles, drivers, shifts, settings] = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => [
    await tx.vehicle.findMany({ where: { status: 'active' }, select: { id: true, licensePlate: true, shiftTemplateId: true }, orderBy: { licensePlate: 'asc' } }),
    await tx.driver.findMany({ where: { status: 'active' }, select: { id: true, firstName: true, lastName: true, employeeNumber: true }, orderBy: { employeeNumber: 'asc' } }),
    await tx.shift.findMany({
      where: { date: { gte: monthStart, lte: monthEnd } },
      // Bewusst nur die tatsächlich benötigten Felder abfragen (statt
      // include: true für ganze Relationen) - reduziert die übertragene
      // Datenmenge und den Speicherbedarf spürbar, besonders bei Monaten
      // mit vielen Schichten.
      select: {
        id: true, date: true, start: true, end: true, breakMinutes: true, commuteMinutes: true, isSubstitute: true,
        driver: { select: { id: true, firstName: true, lastName: true } },
        vehicle: { select: { licensePlate: true } },
        breaks: { select: { start: true, end: true } }
      },
      orderBy: [{ date: 'asc' }, { start: 'asc' }]
    }),
    await tx.companySettings.findUnique({ where: { companyId: user.companyId! } })
  ])

  const shiftsByDate = new Map<string, { id: string; driverName: string | null; start: string; end: string; isSubstitute: boolean }[]>()
  shifts.forEach((s) => {
    const key = dateToStr(s.date)
    const entry = { id: s.id, driverName: s.driver ? `${s.driver.firstName} ${s.driver.lastName}` : null, start: s.start, end: s.end, isSubstitute: s.isSubstitute }
    shiftsByDate.set(key, [...(shiftsByDate.get(key) ?? []), entry])
  })

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Dienstplan</h1>

      <details className="mb-6 rounded-xl border border-border">
        <summary className="cursor-pointer bg-surfaceAlt px-4 py-3 text-sm font-semibold">
          Fahrzeugbasierte Auto-Planung (Schichtmodelle)
        </summary>
        <div className="p-4">
          <AutoPlanningForm
            vehicles={vehicles.map((v) => ({ id: v.id, licensePlate: v.licensePlate, hasTemplate: !!v.shiftTemplateId }))}
            defaultStart={monthStart.toISOString().slice(0, 10)}
            defaultEnd={monthEnd.toISOString().slice(0, 10)}
          />
        </div>
      </details>

      <HoursPlanningForm
        vehicles={vehicles.map((v) => ({ id: v.id, licensePlate: v.licensePlate }))}
        drivers={drivers.map((d) => {
          const persNr = stripEmployeeNumberPadding(d.employeeNumber)
          return { id: d.id, name: `${persNr ? persNr + ' – ' : ''}${d.firstName} ${d.lastName}` }
        })}
        defaultYear={year}
        defaultMonth={month}
      />

      <details className="mb-8 mt-8 rounded-xl border border-border">
        <summary className="cursor-pointer bg-surfaceAlt px-4 py-3 text-sm font-semibold">
          Monatskalender
        </summary>
        <div className="p-4">
          <MonthCalendar
            year={year}
            month={month}
            shiftsByDate={shiftsByDate}
            nightStart={settings?.nightStart ?? '22:00'}
            nightEnd={settings?.nightEnd ?? '06:00'}
            basePath="/dienstplan"
          />
        </div>
      </details>

      <h2 className="mb-3 mt-8 flex items-center justify-between text-lg font-semibold">
        <span>Geplante Schichten (nach Fahrer)</span>
        {shifts.length > 0 && (
          <DeleteMonthButton
            action={deleteAllMonthShifts}
            confirmText={`Wirklich ALLE Schichten für ${new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(monthStart)} löschen (alle Fahrer)? Das kann nicht rückgängig gemacht werden.`}
            label="Ganzen Monat löschen"
            hiddenFields={{ year: String(year), month: String(month) }}
          />
        )}
      </h2>
      {shifts.length === 0 ? (
        <Card><p className="text-textMuted">Noch keine Schichten für diesen Monat.</p></Card>
      ) : (
        <div className="space-y-3">
          {Array.from(
            shifts.reduce((map, s) => {
              const key = s.driver ? `${s.driver.firstName} ${s.driver.lastName}` : '—'
              const entry = map.get(key) ?? { driverId: s.driver?.id ?? null, shifts: [] as typeof shifts }
              entry.shifts.push(s)
              map.set(key, entry)
              return map
            }, new Map<string, { driverId: string | null; shifts: typeof shifts }>())
          ).map(([driverName, { driverId, shifts: driverShifts }]) => {
            const monthLabel = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(monthStart)
            const totalNet = driverShifts.reduce((sum, s) => {
              const startMinAbs = clockToMin(s.start)
              let endMinAbs = clockToMin(s.end)
              if (endMinAbs <= startMinAbs) endMinAbs += 1440
              return sum + (endMinAbs - startMinAbs - s.breakMinutes) / 60
            }, 0)
            return (
              <details key={driverName} className="overflow-hidden rounded-xl border border-border" open>
                <summary className="flex cursor-pointer items-center justify-between bg-surfaceAlt px-4 py-3 text-sm font-semibold">
                  <span>{driverName} – {monthLabel} ({driverShifts.length} Schichten, {totalNet.toFixed(2)} h netto)</span>
                </summary>
                {driverId && (
                  <div className="flex justify-end border-b border-border bg-surface px-4 py-2">
                    <DeleteMonthButton
                      action={deleteDriverMonthShifts}
                      confirmText={`Wirklich alle Schichten von ${driverName} für ${monthLabel} löschen? Das kann nicht rückgängig gemacht werden.`}
                      label="Diesen Fahrer-Monat löschen"
                      hiddenFields={{ driverId, year: String(year), month: String(month) }}
                    />
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-textMuted">
                    <tr>
                      <th className="px-4 py-3">Datum</th>
                      <th className="px-4 py-3">Von</th>
                      <th className="px-4 py-3">Bis</th>
                      <th className="px-4 py-3">Pause</th>
                      <th className="px-4 py-3">Netto</th>
                      <th className="px-4 py-3">Gesamt</th>
                      <th className="px-4 py-3">Fahrzeug</th>
                    </tr>
                  </thead>
                  <tbody>
                    {driverShifts.map((s) => {
                      const startMinAbs = clockToMin(s.start)
                      let endMinAbs = clockToMin(s.end)
                      if (endMinAbs <= startMinAbs) endMinAbs += 1440
                      const spanMinutes = endMinAbs - startMinAbs
                      const netHours = (spanMinutes - s.breakMinutes) / 60
                      const totalHours = netHours + s.breakMinutes / 60 + s.commuteMinutes / 60
                      return (
                        <tr key={s.id} className="border-t border-border">
                          <td className="px-4 py-3 font-mono">
                            {fmtDateDEWithWeekday(dateToStr(s.date))}
                            {s.isSubstitute && <span className="ml-2 text-xs text-accent">(Vertretung)</span>}
                          </td>
                          <td className="px-4 py-3 font-mono">{s.start}</td>
                          <td className="px-4 py-3 font-mono">{s.end}</td>
                          <td className="px-4 py-3 font-mono">
                            {formatBreakRanges(startMinAbs, s.breaks.map((b) => ({ start: b.start, end: b.end })))}
                          </td>
                          <td className="px-4 py-3 font-mono">{netHours.toFixed(2)} h</td>
                          <td className="px-4 py-3 font-mono">{totalHours.toFixed(2)} h</td>
                          <td className="px-4 py-3 font-mono">{s.vehicle.licensePlate}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}
