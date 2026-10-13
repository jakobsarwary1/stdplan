import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { getCurrentUser } from '@/lib/auth'
import { generateHoursBasedSchedule, type HoursTarget, type HoursShift } from '@/lib/planning/hoursMode'
import { computeShiftHours, sumShiftHours, computeWage, type WageShiftInput } from '@/lib/planning/wage'
import { fmtDateDEWithWeekday, minToClock, formatBreakRanges } from '@/lib/planning/format'

// Eine Monatstabelle (alle Fahrer) -> pro Fahrer ein tageweiser STUNDENZETTEL
// mit allen Regeln: Schichten über den Monat verteilt (Pausen, Ruhezeiten),
// Zuschläge nach § 3b EStG (Nacht 25/40 %, Sonntag 50 %) auf die reine
// Arbeitszeit, bezahlte Pause, Monats-Lohnsumme. Alles server-seitig gerechnet.

type Row = {
  name: string
  employeeNumber?: string | null
  rate: number
  total: number // bezahlte Gesamtstunden (Netto + Pause)
  sunday: number // Ziel-Sonntagsstunden
  night25: number // Ziel-Nachtstunden 25 %
  night40: number // Ziel-Nachtstunden 40 %
  krank?: string | null
  brutto?: string | null
  abmelden?: string | null
}

const EUR = '#,##0.00 €'
const STD = '0.00'
const NIGHT_START = '22:00'
const NIGHT_END = '06:00'
const MIN_REST_HOURS = 11

function daysInMonth(year: number, month1: number): string[] {
  const out: string[] = []
  const d = new Date(year, month1 - 1, 1)
  while (d.getMonth() === month1 - 1) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user || !user.companyId) {
      return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })
    }

    const { year, month, monthLabel, companyName, rows }:
      { year: number; month: number; monthLabel?: string; companyName?: string; rows: Row[] } = await request.json()

    if (!year || !month) return NextResponse.json({ error: 'Monat/Jahr fehlt.' }, { status: 400 })
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'Keine Fahrerzeilen übergeben.' }, { status: 400 })
    }

    const alleTage = daysInMonth(year, month)

    const wb = new ExcelJS.Workbook()
    wb.creator = companyName || 'stdplan'
    wb.created = new Date()
    wb.calcProperties.fullCalcOnLoad = true

    const sheet = wb.addWorksheet('Stundenzettel', {
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      },
    })

    // Spaltenbreiten (A..H)
    const widths = [20, 10, 10, 11, 11, 11, 11, 13]
    widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w })

    const titel = sheet.addRow([`Stundenzettel  ·  ${companyName ?? ''}  ·  ${monthLabel ?? ''}`.replace(/\s+·\s+·/g, '  ·')])
    titel.font = { bold: true, size: 14 }
    sheet.mergeCells(titel.number, 1, titel.number, 8)
    sheet.addRow([])

    let grandBrutto = 0

    for (const r of rows) {
      const rate = Number(r.rate) || 0
      const total = Number(r.total) || 0
      const nightTarget = (Number(r.night25) || 0) + (Number(r.night40) || 0)

      // Fahrer-Überschrift
      const kopf = sheet.addRow([
        `${r.name}${r.employeeNumber ? `  (Pers.-Nr. ${r.employeeNumber})` : ''}`,
      ])
      kopf.font = { bold: true, size: 12 }
      sheet.mergeCells(kopf.number, 1, kopf.number, 8)

      // Keine Stunden -> nur Vermerk, keine Schichten erzeugen.
      if (total <= 0) {
        const note = [r.krank && `Krank: ${r.krank}`, r.brutto && `1 % Brutto: ${r.brutto}`, r.abmelden && r.abmelden]
          .filter(Boolean).join('   ·   ')
        const z = sheet.addRow([note || '— keine Stunden eingetragen —'])
        z.font = { italic: true, color: { argb: 'FF888888' } }
        sheet.mergeCells(z.number, 1, z.number, 8)
        sheet.addRow([])
        continue
      }

      const target: HoursTarget = {
        driverId: r.name,
        driverName: r.name,
        hireDate: null,
        excludedDates: [],
        totalHours: total,
        sundayHours: Number(r.sunday) || 0,
        nightHours: nightTarget,
        commuteMinutes: 0, // Arbeitsweg zählt nie
        breakMinutesOverride: null,
        calculateExpenses: false,
        prioritizeDemand: false,
        prioritizeSunday: (Number(r.sunday) || 0) > 0,
        maximizeNight: (Number(r.night40) || 0) > 0,
        maxFreeDays: null,
        isEinzelfahrer: total >= 100,
      }

      let shifts: HoursShift[] = []
      let warning: string | null = null
      try {
        const res = generateHoursBasedSchedule(year, month - 1, target, new Set(), NIGHT_START, NIGHT_END, MIN_REST_HOURS, [], undefined)
        shifts = res.shifts
        warning = res.warning
      } catch (e) {
        warning = `Konnte nicht geplant werden (${(e as Error).message})`
      }

      const byDate = new Map<string, HoursShift>(shifts.map((s) => [s.date, s]))

      // Kopfzeile der Tagestabelle
      const head = sheet.addRow(['Datum', 'Beginn', 'Ende', 'Pause (Min)', 'Netto Std', 'Nacht 25%', 'Nacht 40%', 'Sonntag 50%'])
      head.font = { bold: true }
      head.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
        c.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } }
      })

      // Tageszeilen (ganzer Monat)
      for (const tag of alleTage) {
        const s = byDate.get(tag)
        if (!s) {
          const z = sheet.addRow([fmtDateDEWithWeekday(tag), 'frei', '', '', '', '', '', ''])
          z.getCell(2).font = { color: { argb: 'FFAAAAAA' } }
          continue
        }
        const h = computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.breaks })
        const z = sheet.addRow([
          fmtDateDEWithWeekday(tag),
          minToClock(s.startMin),
          minToClock(s.endMin),
          s.breakMinutes,
          round2(s.netHours),
          round2(h.night25),
          round2(h.night40),
          round2(h.sunday50),
        ])
        for (const col of [5, 6, 7, 8]) z.getCell(col).numFmt = STD
        // Pausenlage als Kommentar/Hinweis in Spalte Pause
        if (s.breaks?.length) z.getCell(4).note = formatBreakRanges(s.startMin, s.breaks)
      }

      // Monatssumme + Lohn
      const wageShifts: WageShiftInput[] = shifts.map((s) => ({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.breaks }))
      const monthly = sumShiftHours(wageShifts, new Set(), 0)
      const w = computeWage(monthly, rate)
      grandBrutto += w.brutto ?? 0

      const sum = sheet.addRow([
        'Summe', '', '', '', round2(monthly.paidHours), round2(monthly.night25), round2(monthly.night40), round2(monthly.sunday50),
      ])
      sum.font = { bold: true }
      sum.eachCell((c) => { c.border = { top: { style: 'thin', color: { argb: 'FFBFBFBF' } } } })
      for (const col of [5, 6, 7, 8]) sum.getCell(col).numFmt = STD

      // Lohn-Block
      const lohn = (label: string, val: number | null) => {
        const z = sheet.addRow([label, '', '', '', '', '', '', val ?? 0])
        z.getCell(8).numFmt = EUR
        sheet.mergeCells(z.number, 1, z.number, 7)
        z.getCell(1).alignment = { horizontal: 'right' }
        return z
      }
      lohn(`Grundlohn (${round2(monthly.totalPaidHours)} bezahlte Std × ${rate.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €)`, w.grundlohn)
      if ((w.night25Amount ?? 0) > 0) lohn('Zuschlag Nacht 25 %', w.night25Amount)
      if ((w.night40Amount ?? 0) > 0) lohn('Zuschlag Nacht 40 %', w.night40Amount)
      if ((w.sunday50Amount ?? 0) > 0) lohn('Zuschlag Sonntag 50 %', w.sunday50Amount)
      const brutto = lohn('Lohn gesamt (brutto)', w.brutto)
      brutto.font = { bold: true }

      // Textvermerke
      const notes = [r.krank && `Krank: ${r.krank}`, r.brutto && `1 % Brutto: ${r.brutto}`, r.abmelden && r.abmelden, warning && `⚠ ${warning}`]
        .filter(Boolean).join('   ·   ')
      if (notes) {
        const z = sheet.addRow([notes])
        z.font = { italic: true, size: 9, color: { argb: 'FF777777' } }
        sheet.mergeCells(z.number, 1, z.number, 8)
      }
      sheet.addRow([])
    }

    // Gesamtsumme aller Fahrer
    const g = sheet.addRow(['Lohnsumme alle Fahrer (brutto)', '', '', '', '', '', '', round2(grandBrutto)])
    g.font = { bold: true, size: 12 }
    g.getCell(8).numFmt = EUR
    sheet.mergeCells(g.number, 1, g.number, 7)
    g.getCell(1).alignment = { horizontal: 'right' }

    const buf = await wb.xlsx.writeBuffer()
    const safeMonth = (monthLabel || 'Monat').replace(/[^A-Za-z0-9ÄÖÜäöü ]/g, '').replace(/\s+/g, '_')
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Stundenzettel_${safeMonth}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Stundenzettel-Excel fehlgeschlagen:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
