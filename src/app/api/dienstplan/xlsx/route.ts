import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { type ExactShift } from '@/lib/planning/exact'
import { berechneManuell, erstellePlan, type DayInput } from '@/lib/planning/manual'
import { buildStundenzettelWorkbook } from '@/lib/planning/stundenzettelExcel'
import { computeShiftHours, sumShiftHours, computeWage } from '@/lib/planning/wage'

/** Eingabezeile aus der Monatstabelle (ein Fahrer). */
type DriverInput = {
  name: string
  employeeNumber?: string | null
  rate: number
  total: number
  sunday: number
  night25: number
  night40: number
  krank?: string | null
  brutto?: string | null
  abmelden?: string | null
  /** Gesetzte Tage ersetzen die automatische Verteilung. Von/Bis ist hier das Fenster. */
  tage?: { date: string; von: string; bis: string; bezahlt: number }[] | null
}

type XlsxRow = {
  driverName: string
  employeeNumber?: string | null
  date: string // bereits formatiert (nur für freie Tage als Text verwendet)
  isoDate: string // "YYYY-MM-DD"
  startMin: number
  endMin: number
  breakOffsetMin: number // Pausenbeginn als Offset (Min.) nach Schichtbeginn
  breakMinutes: number
  commuteMinutes: number
  netHours: number
  /** Bezahlte Stunden = Schichtspanne Beginn→Ende (Pause bezahlt, Weg raus). */
  paidHours: number
  totalHours: number
  vehiclePlate: string
  night25: number
  night40: number
  sunday50: number
  holiday125: number
  isFree?: boolean
  /** Grund der Abwesenheit ("Beurlaubt", "Krankgeschrieben"); leer = einfach frei. */
  freeLabel?: string | null
}

type XlsxSummary = {
  driverName: string
  /** Bezahlte Stunden (Σ Schichtspannen, Pause bezahlt, Weg raus). */
  paidHours: number
  /** Entgeltfortzahlung im Krankheitsfall - keine geleistete Arbeitszeit, aber Teil der Monatssumme. */
  sickHours?: number
  night25: number
  night40: number
  sunday50: number
  holiday125: number
  grossWage?: number | null
  hourlyRate?: number | null
  night25Amount?: number | null
  night40Amount?: number | null
  sunday50Amount?: number | null
  holiday125Amount?: number | null
}

/** Alle Kalendertage eines Monats als ISO-Strings. */
function monthIsoDays(year: number, month1: number): string[] {
  const out: string[] = []
  const d = new Date(year, month1 - 1, 1)
  while (d.getMonth() === month1 - 1) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

function freeRow(name: string, emp: string | null, iso: string): XlsxRow {
  return {
    driverName: name, employeeNumber: emp, date: iso, isoDate: iso, startMin: 0, endMin: 0,
    breakOffsetMin: 0, breakMinutes: 0, commuteMinutes: 0, netHours: 0, paidHours: 0, totalHours: 0,
    vehiclePlate: '', night25: 0, night40: 0, sunday50: 0, holiday125: 0, isFree: true,
  }
}

/**
 * Aus der Monatstabelle (ein Eintrag je Fahrer) für jeden Fahrer mit Stunden
 * einen tageweisen Schichtentwurf erzeugen und als XlsxRow/XlsxSummary
 * aufbereiten. Die eingetippten Sonntags-/Nachtstunden sind Zielvorgaben; die
 * Startwerte Beginn/Ende/Pause landen als editierbare Felder im Excel, wo die
 * Formeln dann alles live nachrechnen.
 */
function buildPlan(drivers: DriverInput[], year: number, month: number): { rows: XlsxRow[]; summaries: XlsxSummary[] } {
  const tage = monthIsoDays(year, month)
  const rows: XlsxRow[] = []
  const summaries: XlsxSummary[] = []

  for (const dr of drivers) {
    const total = Number(dr.total) || 0
    const manuelleTage = (dr.tage ?? []).filter((t) => (Number(t.bezahlt) || 0) > 0 && t.date)
    if (total <= 0 && manuelleTage.length === 0) continue // ohne Stunden kein Block
    const rate = Number(dr.rate) || 0
    const name = dr.name
    const emp = dr.employeeNumber ?? null

    let shifts: ExactShift[] = []
    const hinweis = new Map<string, string>()
    try {
      if (manuelleTage.length > 0) {
        // Von/Bis der Eingabe ist das Fenster. In die Excel-Spalten Von/Bis
        // kommen danach die gerechneten Uhrzeiten Start und Ende.
        const eingabe: DayInput[] = manuelleTage.map((t) => ({
          date: t.date, aktiv: true, von: t.von, bis: t.bis, bezahlt: Number(t.bezahlt) || 0,
        }))
        const res = berechneManuell(eingabe)
        for (const t of res.tage) {
          if (t.warnung) hinweis.set(t.date, t.warnung)
          if (t.startMin == null || t.endMin == null || t.bezahlt <= 0) continue
          shifts.push({
            date: t.date, startMin: t.startMin, endMin: t.endMin,
            breakMinutes: t.pause, breaks: t.breaks, netHours: t.netto,
          })
        }
      } else {
        const res = erstellePlan(year, month, {
          bezahlt: total, sunday: Number(dr.sunday) || 0,
          n25: Number(dr.night25) || 0, n40: Number(dr.night40) || 0,
        })
        for (const t of res.tage) {
          if (t.warnung) hinweis.set(t.date, t.warnung)
          if (t.startMin == null || t.endMin == null || t.bezahlt <= 0) continue
          shifts.push({
            date: t.date, startMin: t.startMin, endMin: t.endMin,
            breakMinutes: t.pause, breaks: t.breaks, netHours: t.netto,
          })
        }
        if (res.warnings.length > 0 && shifts[0]) {
          const vorher = hinweis.get(shifts[0].date)
          hinweis.set(shifts[0].date, [vorher, res.warnings.join(' · ')].filter(Boolean).join(' '))
        }
      }
    } catch { shifts = [] }

    const byDate = new Map(shifts.map((s) => [s.date, s]))
    for (const iso of tage) {
      const s = byDate.get(iso)
      if (!s) { rows.push(freeRow(name, emp, iso)); continue }
      const paidHours = (s.endMin - s.startMin) / 60
      const h = computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.breaks })
      rows.push({
        driverName: name, employeeNumber: emp, date: iso, isoDate: iso,
        startMin: s.startMin, endMin: s.endMin,
        breakOffsetMin: s.breaks[0]?.start ?? 0, breakMinutes: s.breakMinutes, commuteMinutes: 0,
        netHours: paidHours, paidHours, totalHours: paidHours, vehiclePlate: '',
        night25: h.night25, night40: h.night40, sunday50: h.sunday50, holiday125: h.holiday125, isFree: false,
        freeLabel: hinweis.get(iso) ?? null,
      })
    }

    const monthly = sumShiftHours(shifts.map((s) => ({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.breaks })), new Set(), 0)
    const w = computeWage(monthly, rate)
    summaries.push({
      driverName: name, paidHours: monthly.paidHours, sickHours: 0,
      night25: monthly.night25, night40: monthly.night40, sunday50: monthly.sunday50, holiday125: monthly.holiday125,
      hourlyRate: rate, night25Amount: w.night25Amount, night40Amount: w.night40Amount,
      sunday50Amount: w.sunday50Amount, holiday125Amount: w.holiday125Amount, grossWage: w.brutto,
    })
  }
  return { rows, summaries }
}

export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser || !currentUser.companyId) {
      return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })
    }

    const { year, month, monthLabel, companyName, rows: driverRows }:
      { year: number; month: number; monthLabel?: string; companyName?: string; rows: DriverInput[] } = await request.json()

    if (!year || !month) return NextResponse.json({ error: 'Monat/Jahr fehlt.' }, { status: 400 })
    if (!Array.isArray(driverRows) || driverRows.length === 0) return NextResponse.json({ error: 'Keine Fahrerzeilen übergeben.' }, { status: 400 })

    const { rows, summaries } = buildPlan(driverRows, year, month)
    if (rows.length === 0) return NextResponse.json({ error: 'Kein Fahrer mit Stunden eingetragen.' }, { status: 400 })

    const workbook = await buildStundenzettelWorkbook({
      rows,
      summaries,
      title: 'Stundenzettel',
      companyName,
      monthLabel,
    })
    const buffer = await workbook.xlsx.writeBuffer()
    const safeMonth = (monthLabel || 'Monat').replace(/[^A-Za-z0-9ÄÖÜäöü ]/g, '').replace(/\s+/g, '_')
    return new NextResponse(Buffer.from(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Stundenzettel_${safeMonth}.xlsx"`,
        'Cache-Control': 'no-store',
      }
    })
  } catch (err) {
    console.error('Excel-Erzeugung fehlgeschlagen:', err)
    return NextResponse.json(
      { error: 'Excel-Erzeugung fehlgeschlagen.', details: (err as Error).message },
      { status: 500 }
    )
  }
}
