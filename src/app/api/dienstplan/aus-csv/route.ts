import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { workbookForPlans } from '@/lib/planning/uberExcel'
import { buildPlansFromCsv, monthLabelDE, timesheetView, timesheetHours, findeDoppelPaare, type DriverPlan } from '@/lib/planning/uberPlan'
import { buildPlansFromFahrlygoCsv, looksLikeFahrlygo } from '@/lib/planning/fahrlygoPlan'
import { buildCsvForPlans } from '@/lib/planning/uberCsv'
import { buildWorkbookPerDriver } from '@/lib/planning/uberMappe'
import { planAnZiel, planExakt, planPersonal, type PersonalTyp } from '@/lib/planning/uberZielPlan'
import { feiertageImMonat } from '@/lib/planning/feiertage'

/** Pro Fahrer optional die Monats-Zielstunden (aus der Lohnabrechnung). */
type Ziel = { gesamt?: number; sonntag?: number; nacht25?: number; nacht40?: number; feiertag?: number; krank?: string; krankH?: number; typ?: string }

/**
 * Parst eine Krank-Eingabe zu ISO-Tagen des Monats ("YYYY-MM"). Erlaubt:
 *   "10.–14.02"  "10.-14."  "03.02, 17.02"  "3, 17"  (Bereiche und Einzeltage).
 * Der Monat kommt aus `month`; eine abweichende Monatszahl in der Eingabe wird
 * ignoriert (es zählt der Monat des Stundenzettels).
 */
function parseKrankTage(raw: string | undefined, month: string): string[] {
  if (!raw || !/^\d{4}-\d{2}$/.test(month)) return []
  const letzter = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  const tage = new Set<number>()
  for (const token of raw.split(/[,;]/)) {
    const m = token.trim().match(/^(\d{1,2})\s*[.]?\s*[–\-]\s*(\d{1,2})/) // Bereich
    if (m) { const a = Number(m[1]), b = Number(m[2]); for (let d = Math.min(a, b); d <= Math.max(a, b); d++) tage.add(d); continue }
    const s = token.trim().match(/^(\d{1,2})/) // Einzeltag
    if (s) tage.add(Number(s[1]))
  }
  return [...tage].filter((d) => d >= 1 && d <= letzter).sort((a, b) => a - b)
    .map((d) => `${month}-${String(d).padStart(2, '0')}`)
}

/**
 * Wendet die Zielvorgaben an. `exakt` (Standard): der Exakt-Planer trifft
 * Gesamt UND alle Zuschläge (Sonntag/Nacht 25/Nacht 40) genau, mit frei
 * gesetzten Uhrzeiten. `exakt=false`: der Echte-Zeiten-Planer bleibt möglichst
 * nah an den tatsächlichen Uber-Fahrzeiten (best-effort bei den Zuschlägen).
 */
function mitZielen(plans: DriverPlan[], ziele: Record<string, Ziel> | undefined, exakt: boolean, bundesland: string, raster: number): DriverPlan[] {
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
      krankTage: parseKrankTage(z?.krank, month),
      krankStunden: Number(z?.krankH) || 0,
    }
  }
  const alsTyp = (z?: Ziel): PersonalTyp | null => (z?.typ === 'reinigung' || z?.typ === 'buero' ? z.typ : null)
  const out = plans.map((p) => {
    const z = ziele[p.name]
    const g = Number(z?.gesamt) || 0
    if (g <= 0) return p
    const typ = alsTyp(z)
    if (typ) return planPersonal(p.name, p.month, typ, g, raster)
    const ziel = zielFuer(p.name, p.month, z)
    // Hat der Fahrer echte Uber-Fahrten? Dann die ECHTEN Startzeiten behalten
    // (planAnZiel, Streck-Modus): echte Von-Zeiten, Längen/Pausen gestaucht bzw.
    // gestreckt (bis legal 10 h), sodass Gesamt UND Sonntag EXAKT stimmen; freie
    // Tage verteilt, §11/§5 beachtet. Nur manuell getippte Fahrer OHNE Fahrten
    // bekommen künstliche Zeiten.
    const hatEchte = p.days.some((d) => d.kind === 'schicht' && d.shifts.length > 0)
    if (!hatEchte) return planExakt(p.name, p.month, ziel, raster)
    return planAnZiel(p, ziel, { raster })
  })
  // Personen, die NICHT in der CSV vorkommen (manuell getippt): eigenen Zettel
  // anlegen. Personal (Reinigung/Büro) immer; Fahrer ohne Fahrten nur im Exakt-Modus.
  {
    const monat = plans[0]?.month ?? ''
    const vorhanden = new Set(plans.map((p) => p.name))
    for (const [name, z] of Object.entries(ziele)) {
      if (vorhanden.has(name) || (Number(z?.gesamt) || 0) <= 0 || !monat) continue
      const typ = alsTyp(z)
      if (typ) out.push(planPersonal(name, monat, typ, Number(z.gesamt), raster))
      else if (exakt) out.push(planExakt(name, monat, zielFuer(name, monat, z), raster))
    }
  }
  return out
}

export const dynamic = 'force-dynamic'

const MAX_CSV = 8_000_000

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user || !user.companyId) return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })

  let body: { csv?: string; format?: string; ziele?: Record<string, Ziel>; merges?: string[][]; exakt?: boolean; raster?: number }
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
  const raster = body.raster === 1 || body.raster === 10 ? body.raster : 15
  const plans = mitZielen(roh, body.ziele, body.exakt !== false, bundesland, raster)

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
    drivers: plans.map((p) => {
      const h = timesheetHours(p)
      const sundaysWorked = p.days.filter((d) => d.kind === 'schicht' && d.shifts.length > 0 && d.weekday === 0).length
      return {
        name: p.name,
        paidH: p.paidH,
        nettoH: p.nettoH,
        workDays: p.workDays,
        freeDays: p.freeDays,
        ruheTage: p.ruheTage,
        violations: p.violations,
        weekNotes: p.weekNotes,
        rows: timesheetView(p),
        // Für die Jahres-Stundenübersicht: Summen + gearbeitete Sonntage + Soll.
        hours: { worked: h.workedHours, sonntag: h.sunday50, nacht25: h.night25, nacht40: h.night40, feiertag: h.holiday125, krank: h.sickHours },
        sundaysWorked,
        soll: p.ziel ?? null,
      }
    }),
  })
}
