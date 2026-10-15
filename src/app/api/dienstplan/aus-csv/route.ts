import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { workbookForPlans } from '@/lib/planning/uberExcel'
import { buildPlansFromCsv, monthLabelDE, timesheetView } from '@/lib/planning/uberPlan'

export const dynamic = 'force-dynamic'

const MAX_CSV = 8_000_000

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user || !user.companyId) return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })

  let body: { csv?: string; format?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Die Datei ließ sich nicht lesen.' }, { status: 400 })
  }
  const csv = body.csv ?? ''
  if (!csv.trim()) return NextResponse.json({ error: 'Die CSV ist leer.' }, { status: 400 })
  if (csv.length > MAX_CSV) return NextResponse.json({ error: 'Die CSV ist zu groß.' }, { status: 400 })

  const plans = buildPlansFromCsv([csv])
  if (!plans.length) {
    return NextResponse.json({ error: 'Keine abgeschlossenen Fahrten gefunden. Ist das eine Uber-Fahrtliste?' }, { status: 400 })
  }

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

  return NextResponse.json({
    month: plans[0].month,
    monthLabel: plans[0].month ? monthLabelDE(plans[0].month) : '',
    drivers: plans.map((p) => ({
      name: p.name,
      paidH: p.paidH,
      workDays: p.workDays,
      freeDays: p.freeDays,
      ruheTage: p.ruheTage,
      violations: p.violations,
      weekNotes: p.weekNotes,
      rows: timesheetView(p),
    })),
  })
}
