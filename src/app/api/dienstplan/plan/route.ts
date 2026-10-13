import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { generateHoursBasedSchedule, type HoursTarget } from '@/lib/planning/hoursMode'
import { computeShiftHours } from '@/lib/planning/wage'
import { minToClock } from '@/lib/planning/format'

const MIN_REST_HOURS = 11 // § 5 ArbZG

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

        const sorted = shifts.slice().sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)
        let prevEndMs: number | null = null
        const rowsOut = sorted.map((s) => {
          const [y, m, d] = s.date.split('-').map(Number)
          const startMs = new Date(y, m - 1, d, 0, s.startMin).getTime()
          const endMs = new Date(y, m - 1, d, 0, s.endMin).getTime()
          // Ruhezeit = Lücke zur vorherigen Schicht (Ende -> dieser Beginn), § 5 ArbZG i. d. R. 11 h.
          const ruhe = prevEndMs != null ? round2((startMs - prevEndMs) / 3600000) : null
          prevEndMs = endMs
          const h = computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.breaks })
          return {
            date: s.date,
            von: minToClock(s.startMin),
            bis: minToClock(s.endMin),
            pause: s.breakMinutes,
            netto: round2(s.netHours),
            bezahlt: round2((s.endMin - s.startMin) / 60),
            ruhe,
            n25: round2(h.night25),
            n40: round2(h.night40),
            so: round2(h.sunday50),
          }
        })

        const sum = (sel: (x: typeof rowsOut[number]) => number) => round2(rowsOut.reduce((a, x) => a + sel(x), 0))
        const ruheWerte = rowsOut.map((x) => x.ruhe).filter((v): v is number => v != null)
        const minRuhe = ruheWerte.length ? Math.min(...ruheWerte) : null
        const summe = {
          netto: sum((x) => x.netto), bezahlt: sum((x) => x.bezahlt),
          n25: sum((x) => x.n25), n40: sum((x) => x.n40), so: sum((x) => x.so),
          minRuhe, ruheVerletzt: minRuhe != null && minRuhe < MIN_REST_HOURS,
        }
        return { name: r.name, employeeNumber: r.employeeNumber ?? null, tage: rowsOut.length, paidSum: summe.bezahlt, warning, summe, shifts: rowsOut }
      })

    return NextResponse.json({ drivers })
  } catch (err) {
    console.error('Planungs-Vorschau fehlgeschlagen:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
