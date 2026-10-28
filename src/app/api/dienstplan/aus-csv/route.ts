import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { workbookForPlans } from '@/lib/planning/uberExcel'
import { buildPlansFromCsv, monthLabelDE, timesheetView, findeDoppelVerdacht, type DriverPlan } from '@/lib/planning/uberPlan'
import { buildPlansFromFahrlygoCsv, looksLikeFahrlygo } from '@/lib/planning/fahrlygoPlan'
import { buildCsvForPlans } from '@/lib/planning/uberCsv'
import { buildWorkbookPerDriver } from '@/lib/planning/uberMappe'
import { planAnZiel } from '@/lib/planning/uberZielPlan'

/** Pro Fahrer optional die Monats-Zielstunden (aus der Lohnabrechnung). */
type Ziel = { gesamt?: number; sonntag?: number }

/**
 * Wendet die Zielvorgaben an: Fahrer mit einem Gesamt-Ziel > 0 bekommen die
 * echten Uber-Tage auf exakt diese Monatsstunden (netto, ohne Pause) gebracht.
 */
function mitZielen(plans: DriverPlan[], ziele: Record<string, Ziel> | undefined): DriverPlan[] {
  if (!ziele) return plans
  return plans.map((p) => {
    const z = ziele[p.name]
    const g = Number(z?.gesamt) || 0
    return g > 0 ? planAnZiel(p, { gesamt: g, sonntag: Number(z?.sonntag) || 0 }) : p
  })
}

export const dynamic = 'force-dynamic'

const MAX_CSV = 8_000_000

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user || !user.companyId) return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })

  let body: { csv?: string; format?: string; ziele?: Record<string, Ziel> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Die Datei ließ sich nicht lesen.' }, { status: 400 })
  }
  const csv = body.csv ?? ''
  if (!csv.trim()) return NextResponse.json({ error: 'Die CSV ist leer.' }, { status: 400 })
  if (csv.length > MAX_CSV) return NextResponse.json({ error: 'Die CSV ist zu groß.' }, { status: 400 })

  // Anbieter am CSV-Kopf erkennen: Fahrlygo (Datum;Fahrer;…) oder Uber (trip_activity).
  const roh = looksLikeFahrlygo(csv) ? buildPlansFromFahrlygoCsv([csv]) : buildPlansFromCsv([csv])
  if (!roh.length) {
    return NextResponse.json({ error: 'Keine Fahrten gefunden. Ist das eine Uber- oder Fahrlygo-Fahrtliste?' }, { status: 400 })
  }
  // Zielvorgaben (falls gesetzt) auf die echten Tage anwenden.
  const plans = mitZielen(roh, body.ziele)

  if (body.format === 'xlsx') {
    const wb = await workbookForPlans(plans)
    const buffer = await wb.xlsx.writeBuffer()
    const month = plans[0].month ? monthLabelDE(plans[0].month).replace(/\s+/g, '_') : 'Monat'
    return new NextResponse(Buffer.from(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Stundenzettel_${month}.xlsx"`,
      },
    })
  }

  // Eine Arbeitsmappe, je Fahrer ein eigenes Tabellenblatt (getrennte Tabellen).
  if (body.format === 'mappe') {
    const wb = await buildWorkbookPerDriver(plans)
    const buffer = await wb.xlsx.writeBuffer()
    const month = plans[0].month ? monthLabelDE(plans[0].month).replace(/\s+/g, '_') : 'Monat'
    return new NextResponse(Buffer.from(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Stundenzettel_${month}_je-Fahrer.xlsx"`,
      },
    })
  }

  // Eine CSV, alle Fahrer als getrennte Tabellen.
  if (body.format === 'csv') {
    const { csv, monthLabel } = buildCsvForPlans(plans)
    const month = monthLabel.replace(/\s+/g, '_')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Stundenzettel_${month}_alle-Fahrer.csv"`,
      },
    })
  }

  return NextResponse.json({
    month: plans[0].month,
    monthLabel: plans[0].month ? monthLabelDE(plans[0].month) : '',
    hinweise: findeDoppelVerdacht(plans.map((p) => p.name)),
    drivers: plans.map((p) => ({
      name: p.name,
      paidH: p.paidH,
      nettoH: p.nettoH,
      workDays: p.workDays,
      freeDays: p.freeDays,
      ruheTage: p.ruheTage,
      violations: p.violations,
      weekNotes: p.weekNotes,
      rows: timesheetView(p),
    })),
  })
}
