import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { generateHoursBasedSchedule, type HoursTarget } from '@/lib/planning/hoursMode'
import { minToClock } from '@/lib/planning/format'

// Vorschau der automatischen Schichtplanung (ohne Fahrzeuge): ruft pro Fahrer
// die vorhandene Engine auf und gibt die generierten Tages-Schichten zurück.
// Es wird NICHTS gespeichert – reine Vorschau.

type Row = {
  name: string
  employeeNumber?: string | null
  rate: number
  total: number
  sunday: number
  night25: number
  night40: number
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user || !user.companyId) return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })

    const { year, month, rows }: { year: number; month: number; rows: Row[] } = await request.json()
    if (!year || !month) return NextResponse.json({ error: 'Monat/Jahr fehlt.' }, { status: 400 })
    if (!Array.isArray(rows)) return NextResponse.json({ error: 'Keine Fahrerzeilen.' }, { status: 400 })

    const drivers = rows
      .filter((r) => (Number(r.total) || 0) > 0)
      .map((r) => {
        const total = Number(r.total) || 0
        const target: HoursTarget = {
          driverId: r.name, driverName: r.name, hireDate: null, excludedDates: [],
          totalHours: total, sundayHours: Number(r.sunday) || 0,
          nightHours: (Number(r.night25) || 0) + (Number(r.night40) || 0),
          commuteMinutes: 0, breakMinutesOverride: null, calculateExpenses: false,
          prioritizeDemand: false, prioritizeSunday: (Number(r.sunday) || 0) > 0,
          maximizeNight: (Number(r.night40) || 0) > 0, maxFreeDays: null, isEinzelfahrer: total >= 100,
        }
        let shifts: ReturnType<typeof generateHoursBasedSchedule>['shifts'] = []
        let warning: string | null = null
        try {
          const res = generateHoursBasedSchedule(year, month - 1, target, new Set(), '22:00', '06:00', 11, [], undefined)
          shifts = res.shifts
          warning = res.warning
        } catch (e) { warning = (e as Error).message }

        const rowsOut = shifts
          .slice()
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((s) => ({
            date: s.date,
            von: minToClock(s.startMin),
            bis: minToClock(s.endMin),
            pause: s.breakMinutes,
            netto: round2(s.netHours),
            bezahlt: round2((s.endMin - s.startMin) / 60),
          }))

        const paidSum = round2(rowsOut.reduce((s, x) => s + x.bezahlt, 0))
        return { name: r.name, employeeNumber: r.employeeNumber ?? null, tage: rowsOut.length, paidSum, warning, shifts: rowsOut }
      })

    return NextResponse.json({ drivers })
  } catch (err) {
    console.error('Planungs-Vorschau fehlgeschlagen:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
