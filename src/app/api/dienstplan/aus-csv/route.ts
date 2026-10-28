import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { workbookForPlans } from '@/lib/planning/uberExcel'
import { buildPlansFromCsv, monthLabelDE, timesheetView, findeDoppelPaare, type DriverPlan } from '@/lib/planning/uberPlan'
import { buildPlansFromFahrlygoCsv, looksLikeFahrlygo } from '@/lib/planning/fahrlygoPlan'
import { buildCsvForPlans } from '@/lib/planning/uberCsv'
import { buildWorkbookPerDriver } from '@/lib/planning/uberMappe'
import { planAnZiel, planExakt } from '@/lib/planning/uberZielPlan'
import { feiertageImMonat } from '@/lib/planning/feiertage'

/** Pro Fahrer optional die Monats-Zielstunden (aus der Lohnabrechnung). */
type Ziel = { gesamt?: number; sonntag?: number; nacht25?: number; nacht40?: number; feiertag?: number }

/**
 * Wendet die Zielvorgaben an. `exakt` (Standard): der Exakt-Planer trifft
 * Gesamt UND alle Zuschläge (Sonntag/Nacht 25/Nacht 40) genau, mit frei
 * gesetzten Uhrzeiten. `exakt=false`: der Echte-Zeiten-Planer bleibt möglichst
 * nah an den tatsächlichen Uber-Fahrzeiten (best-effort bei den Zuschlägen).
 */
function mitZielen(plans: DriverPlan[], ziele: Record<string, Ziel> | undefined, exakt: boolean, bundesland: string): DriverPlan[] {
  if (!ziele) return plans
  // Feiertage je Monat (für das Bundesland der Firma) nur bei Bedarf berechnen.
  // Sie werden NICHT automatisch angewendet – erst wenn für einen Fahrer
  // tatsächlich Feiertagsstunden vorgegeben sind, kommen sie ins Spiel.
  const feCache = new Map<string, string[]>()
  const feiertage = (month: string) => {
    if (!feCache.has(month)) feCache.set(month, feiertageImMonat(month, bundesland))
    return feCache.get(month)!
  }
  const zielFuer = (name: string, month: string, z: Ziel) => {
    const fe = Number(z?.feiertag) || 0
    return {
      gesamt: Number(z?.gesamt) || 0,
      sonntag: Number(z?.sonntag) || 0,
      nacht25: Number(z?.nacht25) || 0,
      nacht40: Number(z?.nacht40) || 0,
      feiertag: fe,
      // Feiertage nur anhängen, wenn tatsächlich Feiertagsstunden vorgegeben sind.
      feiertage: fe > 0 ? feiertage(month) : [],
    }
  }
  const out = plans.map((p) => {
    const z = ziele[p.name]
    const g = Number(z?.gesamt) || 0
    if (g <= 0) return p
    const ziel = zielFuer(p.name, p.month, z)
    return exakt ? planExakt(p.name, p.month, ziel) : planAnZiel(p, ziel)
  })
  // Lohn-Fahrer, die NICHT in der CSV vorkommen: im Exakt-Modus einen eigenen
  // Stundenzettel anlegen (freie Zeiten – es braucht nur Name + Monat).
  if (exakt) {
    const monat = plans[0]?.month ?? ''
    const vorhanden = new Set(plans.map((p) => p.name))
    for (const [name, z] of Object.entries(ziele)) {
      if (vorhanden.has(name) || (Number(z?.gesamt) || 0) <= 0 || !monat) continue
      out.push(planExakt(name, monat, zielFuer(name, monat, z)))
    }
  }
  return out
}

export const dynamic = 'force-dynamic'

const MAX_CSV = 8_000_000

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user || !user.companyId) return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })

  let body: { csv?: string; format?: string; ziele?: Record<string, Ziel>; merges?: string[][]; exakt?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Die Datei ließ sich nicht lesen.' }, { status: 400 })
  }
  const csv = body.csv ?? ''
  if (!csv.trim()) return NextResponse.json({ error: 'Die CSV ist leer.' }, { status: 400 })
  if (csv.length > MAX_CSV) return NextResponse.json({ error: 'Die CSV ist zu groß.' }, { status: 400 })

  // Anbieter am CSV-Kopf erkennen: Fahrlygo (Datum;Fahrer;…) oder Uber (trip_activity).
  const merges = Array.isArray(body.merges) ? body.merges : []
  const roh = looksLikeFahrlygo(csv) ? buildPlansFromFahrlygoCsv([csv], merges) : buildPlansFromCsv([csv], merges)
  if (!roh.length) {
    return NextResponse.json({ error: 'Keine Fahrten gefunden. Ist das eine Uber- oder Fahrlygo-Fahrtliste?' }, { status: 400 })
  }
  // Bundesland der Firma (für die gesetzlichen Feiertage, § 3b EStG).
  const settings = await prisma.companySettings.findUnique({
    where: { companyId: user.companyId },
    select: { bundesland: true },
  })
  const bundesland = settings?.bundesland || 'NW'

  // Zielvorgaben anwenden. Standard: exakt (freie Zeiten) – trifft alle Zahlen
  // genau. exakt=false nutzt die echten Uber-Zeiten (best-effort).
  const plans = mitZielen(roh, body.ziele, body.exakt !== false, bundesland)

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
    dupePairs: findeDoppelPaare(plans.map((p) => p.name)),
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
