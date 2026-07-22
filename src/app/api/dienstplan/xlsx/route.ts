import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { getCurrentUser } from '@/lib/auth'

type XlsxRow = {
  driverName: string
  date: string // bereits formatiert (nur für freie Tage als Text verwendet)
  isoDate: string // "YYYY-MM-DD"
  startMin: number
  endMin: number
  breakOffsetMin: number // Pausenbeginn als Offset (Min.) nach Schichtbeginn
  breakMinutes: number
  commuteMinutes: number
  netHours: number
  totalHours: number
  vehiclePlate: string
  night25: number
  night40: number
  sunday50: number
  holiday125: number
  isFree?: boolean
}

type XlsxSummary = {
  driverName: string
  totalNet: number
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

// (isoDate + Minuten seit Mitternacht) -> Excel-Datumszahl (Tage seit
// 1899-12-30). Über Date.UTC, damit keine Zeitzonen-Verschiebung entsteht;
// Minuten > 1440 rollen automatisch in den Folgetag.
function excelSerial(isoDate: string, minutes: number): number {
  const [y, m, d] = isoDate.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + minutes * 60000
  return ms / 86400000 + 25569
}
function colLetter(n: number): string {
  let s = ''
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}
// Nachname = ganzer Name ohne den ersten Namensteil (Vorname).
function lastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/)
  return parts.length > 1 ? parts.slice(1).join(' ') : fullName.trim()
}

// ---- JS-Spiegel der Excel-Zuschlagsformeln (identische Fenster/Logik),
// nur um die `result`-Werte vorzuberechnen, damit die Datei sofort korrekte
// Zahlen zeigt. In Excel rechnen die FORMELN bei jeder Änderung neu. ----
function ov2day(a: number, b: number, w1: number, w2: number): number {
  const D = Math.floor(a)
  return Math.max(0, Math.min(b, D + w2) - Math.max(a, D + w1)) + Math.max(0, Math.min(b, D + 1 + w2) - Math.max(a, D + 1 + w1))
}
function weekday2(D: number): number {
  const dow = new Date((Math.round(D) - 25569) * 86400000).getUTCDay()
  return dow === 0 ? 7 : dow
}
function fullDay(a: number, b: number, sunday: boolean, holidaySerials: Set<number>): number {
  const D = Math.floor(a)
  let t = 0
  for (const dd of [D, D + 1]) {
    const isSun = weekday2(dd) === 7
    const gate = sunday ? isSun : (holidaySerials.has(dd) && !isSun)
    if (gate) t += Math.max(0, Math.min(b, dd + 1) - Math.max(a, dd))
  }
  return t
}

export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser || !currentUser.companyId) {
      return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })
    }

    const { title, rows, summaries, monthLabel, vehiclePlate, holidayDates: holidayDatesRaw }:
      { title: string; rows: XlsxRow[]; summaries?: XlsxSummary[]; monthLabel?: string; vehiclePlate?: string; holidayDates?: string[] } = await request.json()

    const holidaySerials = (holidayDatesRaw ?? []).map((h) => Math.floor(excelSerial(h, 0)))
    const holidaySerialSet = new Set(holidaySerials)

    // ---- Spaltenlayout (fest, alle Felder sind Formeln außer den
    // Eingabefeldern Beginn/Ende/Pause/Weg/Pause-Offset) ----
    const COLS = {
      fahrer: 1, datum: 2, beginn: 3, ende: 4, pause: 5, weg: 6,
      netto: 7, gesamt: 8, ruhe: 9, n25: 10, n40: 11, so50: 12, fe125: 13,
      pOffset: 14, pBeginn: 15, pEnde: 16
    }
    const HEADERS: [number, string, number][] = [
      [COLS.fahrer, 'Fahrer', 18], [COLS.datum, 'Datum', 16],
      [COLS.beginn, 'Beginn', 17], [COLS.ende, 'Ende', 17],
      [COLS.pause, 'Pause (Min.)', 11], [COLS.weg, 'Weg (Min.)', 10],
      [COLS.netto, 'Netto (Std.)', 11], [COLS.gesamt, 'Gesamt (Std.)', 12],
      [COLS.ruhe, 'Ruhezeit vorher (Std.)', 20],
      [COLS.n25, 'Nacht 25%', 11], [COLS.n40, 'Nacht 40%', 11],
      [COLS.so50, 'Sonntag 50%', 12], [COLS.fe125, 'Feiertag 125%', 13],
      [COLS.pOffset, 'Pausenlage (Hilfsspalte)', 22], [COLS.pBeginn, 'Pause-Beginn (Hilfsspalte)', 16], [COLS.pEnde, 'Pause-Ende (Hilfsspalte)', 16]
    ]
    const nCols = HEADERS.length
    const L = (c: number) => colLetter(c)

    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'FleetOS'
    workbook.created = new Date()
    workbook.calcProperties.fullCalcOnLoad = true // erzwingt Neuberechnung beim Öffnen

    const sheet = workbook.addWorksheet('Dienstplan')
    // Alle Spalten linksbündig (Excel würde Zahlen/Datum sonst rechtsbündig
    // ausrichten).
    HEADERS.forEach(([c, , w]) => { sheet.getColumn(c).width = w; sheet.getColumn(c).alignment = { horizontal: 'left' } })

    const titleParts = [title, monthLabel, vehiclePlate ? `[${vehiclePlate}]` : ''].filter(Boolean)
    const titleRow = sheet.addRow([titleParts.join('  ·  ')])
    titleRow.font = { bold: true, size: 14 }
    sheet.mergeCells(1, 1, 1, nCols)
    sheet.addRow([])

    const headerRow = sheet.addRow(HEADERS.map(([, label]) => label))
    headerRow.font = { bold: true }
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } } }
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'left' }
    })

    const DT = 'dd.mm.yyyy hh:mm'
    const inputFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } } // hellgelb = editierbar

    // Inline-Ausdruck: Überlappung von [a,b] mit dem Tagesfenster [w1,w2]
    // über zwei Tage (Schicht ≤ 2 Kalendertage).
    const ov = (a: string, b: string, w1: string, w2: string) =>
      `MAX(0,MIN(${b},INT(${a})+${w2})-MAX(${a},INT(${a})+${w1}))+MAX(0,MIN(${b},INT(${a})+1+${w2})-MAX(${a},INT(${a})+1+${w1}))`
    const fullSun = (a: string, b: string) =>
      `(WEEKDAY(INT(${a}),2)=7)*MAX(0,MIN(${b},INT(${a})+1)-MAX(${a},INT(${a})))+(WEEKDAY(INT(${a})+1,2)=7)*MAX(0,MIN(${b},INT(${a})+2)-MAX(${a},INT(${a})+1))`
    const holGate = (dd: string) =>
      holidaySerials.length === 0 ? '0' : `(OR(${holidaySerials.map((s) => `INT(${dd})=${s}`).join(',')}))*(WEEKDAY(${dd},2)<>7)`
    const fullHol = (a: string, b: string) =>
      holidaySerials.length === 0 ? '0'
        : `(${holGate(`INT(${a})`)})*MAX(0,MIN(${b},INT(${a})+1)-MAX(${a},INT(${a})))+(${holGate(`INT(${a})+1`)})*MAX(0,MIN(${b},INT(${a})+2)-MAX(${a},INT(${a})+1))`

    let firstDataRow = 0, lastDataRow = 0
    let prevWorkEndeRow = 0, prevWorkEndeSerial = 0

    rows.forEach((r) => {
      if (r.isFree) {
        const row = sheet.addRow([lastName(r.driverName), r.date])
        row.font = { color: { argb: 'FF999999' }, italic: true }
        if (firstDataRow === 0) firstDataRow = row.number
        lastDataRow = row.number
        return
      }
      const R = sheet.addRow([lastName(r.driverName)]).number
      if (firstDataRow === 0) firstDataRow = R
      lastDataRow = R
      const cell = (c: number) => sheet.getCell(R, c)

      // Eingabefelder
      const beginnSerial = excelSerial(r.isoDate, r.startMin)
      const endeSerial = excelSerial(r.isoDate, r.endMin)
      const cB = cell(COLS.beginn); cB.value = beginnSerial; cB.numFmt = DT; cB.fill = inputFill
      const cE = cell(COLS.ende); cE.value = endeSerial; cE.numFmt = DT; cE.fill = inputFill
      const cP = cell(COLS.pause); cP.value = r.breakMinutes; cP.numFmt = '0'; cP.fill = inputFill
      const cW = cell(COLS.weg); cW.value = r.commuteMinutes; cW.numFmt = '0'; cW.fill = inputFill
      const cO = cell(COLS.pOffset); cO.value = r.breakOffsetMin; cO.numFmt = '0'; cO.fill = inputFill

      const bRef = `${L(COLS.beginn)}${R}`, eRef = `${L(COLS.ende)}${R}`
      const pRef = `${L(COLS.pause)}${R}`, wRef = `${L(COLS.weg)}${R}`, oRef = `${L(COLS.pOffset)}${R}`
      const pbRef = `${L(COLS.pBeginn)}${R}`, peRef = `${L(COLS.pEnde)}${R}`

      // Datum = Beginn (nur anders formatiert)
      const cD = cell(COLS.datum); cD.value = { formula: bRef, result: beginnSerial }; cD.numFmt = 'ddd dd.mm.yyyy'

      // Pause-Beginn / Pause-Ende (Hilfsspalten für die Zuschlagsformeln)
      const pbSerial = excelSerial(r.isoDate, r.startMin + r.breakOffsetMin)
      const peSerial = excelSerial(r.isoDate, r.startMin + r.breakOffsetMin + r.breakMinutes)
      const cPB = cell(COLS.pBeginn); cPB.value = { formula: `${bRef}+${oRef}/1440`, result: pbSerial }; cPB.numFmt = DT
      const cPE = cell(COLS.pEnde); cPE.value = { formula: `${pbRef}+${pRef}/1440`, result: peSerial }; cPE.numFmt = DT

      // Netto / Gesamt
      const cN = cell(COLS.netto); cN.value = { formula: `(${eRef}-${bRef})*24-${pRef}/60`, result: r.netHours }; cN.numFmt = '0.00'
      const cG = cell(COLS.gesamt); cG.value = { formula: `(${eRef}-${bRef})*24+${wRef}/60`, result: r.totalHours }; cG.numFmt = '0.00'

      // Ruhezeit gegenüber der vorherigen Arbeitsschicht
      const cR = cell(COLS.ruhe)
      if (prevWorkEndeRow > 0) {
        cR.value = { formula: `(${bRef}-${L(COLS.ende)}${prevWorkEndeRow})*24`, result: (beginnSerial - prevWorkEndeSerial) * 24 }
      }
      cR.numFmt = '0.00'

      // Zuschläge (Formel = Überlappung Schicht − Überlappung Pause)
      const n40 = (ov2day(beginnSerial, endeSerial, 0, 4 / 24) - ov2day(pbSerial, peSerial, 0, 4 / 24)) * 24
      const n25 = ((ov2day(beginnSerial, endeSerial, 4 / 24, 6 / 24) + ov2day(beginnSerial, endeSerial, 20 / 24, 1))
        - (ov2day(pbSerial, peSerial, 4 / 24, 6 / 24) + ov2day(pbSerial, peSerial, 20 / 24, 1))) * 24
      const so50 = (fullDay(beginnSerial, endeSerial, true, holidaySerialSet) - fullDay(pbSerial, peSerial, true, holidaySerialSet)) * 24
      const fe125 = (fullDay(beginnSerial, endeSerial, false, holidaySerialSet) - fullDay(pbSerial, peSerial, false, holidaySerialSet)) * 24

      const cN25 = cell(COLS.n25)
      cN25.value = { formula: `((${ov(bRef, eRef, '4/24', '6/24')})+(${ov(bRef, eRef, '20/24', '1')})-((${ov(pbRef, peRef, '4/24', '6/24')})+(${ov(pbRef, peRef, '20/24', '1')})))*24`, result: n25 }
      cN25.numFmt = '0.00'
      const cN40 = cell(COLS.n40)
      cN40.value = { formula: `((${ov(bRef, eRef, '0', '4/24')})-(${ov(pbRef, peRef, '0', '4/24')}))*24`, result: n40 }
      cN40.numFmt = '0.00'
      const cSo = cell(COLS.so50)
      cSo.value = { formula: `((${fullSun(bRef, eRef)})-(${fullSun(pbRef, peRef)}))*24`, result: so50 }
      cSo.numFmt = '0.00'
      const cFe = cell(COLS.fe125)
      cFe.value = { formula: `((${fullHol(bRef, eRef)})-(${fullHol(pbRef, peRef)}))*24`, result: fe125 }
      cFe.numFmt = '0.00'

      prevWorkEndeRow = R
      prevWorkEndeSerial = endeSerial
    })

    // Hilfsspalten (Pausenlage/Pause-Beginn/Pause-Ende) ausblenden - sie
    // werden nur intern von den Zuschlagsformeln gebraucht (sie legen fest,
    // WANN die Pause innerhalb der Schicht liegt) und würden die Tabelle
    // sonst nur unnötig verbreitern/verwirren.
    sheet.getColumn(COLS.pOffset).hidden = true
    sheet.getColumn(COLS.pBeginn).hidden = true
    sheet.getColumn(COLS.pEnde).hidden = true

    // ---- Monatszusammenfassung DIREKT unter der Tabelle (gleiches Blatt),
    // je Fahrer als Live-Formeln (SUMIFS über die Spalten oberhalb). Der
    // Stundenlohn ist ein editierbares Eingabefeld; Beträge/Bruttolohn
    // rechnen sich mit. ----
    if (summaries && summaries.length > 0 && lastDataRow >= firstDataRow) {
      const colRange = (c: number) => `$${L(c)}$${firstDataRow}:$${L(c)}$${lastDataRow}`
      const fahrerRange = `$${L(COLS.fahrer)}$${firstDataRow}:$${L(COLS.fahrer)}$${lastDataRow}`

      sheet.addRow([])
      const head = sheet.addRow(['Monatszusammenfassung']); head.font = { bold: true, size: 13 }

      const perDriverBruttoRefs: string[] = []
      summaries.filter((s) => s.driverName !== 'Gesamt (alle Fahrer)').forEach((s) => {
        const surname = lastName(s.driverName)
        const nameRow = sheet.addRow([surname]); nameRow.getCell(1).font = { bold: true, size: 12 }
        const nameRef = `$${L(COLS.fahrer)}$${nameRow.number}`

        // Editierbarer Stundenlohn (Eingabefeld)
        const rateRow = sheet.addRow(['Stundenlohn (EUR)'])
        sheet.mergeCells(rateRow.number, 1, rateRow.number, 3)
        const rateCell = rateRow.getCell(4)
        rateCell.value = s.hourlyRate ?? null
        rateCell.numFmt = '0.00'; rateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } }
        const rateRef = `$${L(4)}$${rateRow.number}`

        // Std. (SUMIFS, live) in Spalte 4, Betrag (EUR) in Spalte 5
        const addStat = (label: string, col: number, result: number, factor: number | null, amountResult: number | null | undefined) => {
          const row = sheet.addRow([label])
          sheet.mergeCells(row.number, 1, row.number, 3)
          const stdCell = row.getCell(4)
          stdCell.value = { formula: `SUMIFS(${colRange(col)},${fahrerRange},${nameRef})`, result }
          stdCell.numFmt = '0.00'
          if (factor != null) {
            const amtCell = row.getCell(5)
            amtCell.value = { formula: `${L(4)}${row.number}*${rateRef}*${factor}`, result: amountResult ?? 0 }
            amtCell.numFmt = '0.00 "EUR"'
          }
          return `${L(4)}${row.number}`
        }
        const nettoRef = addStat('Netto (Std.)', COLS.netto, s.totalNet, null, null)
        addStat('Nachtzuschlag 25 %', COLS.n25, s.night25, 0.25, s.night25Amount)
        addStat('Nachtzuschlag 40 % steuerfrei', COLS.n40, s.night40, 0.4, s.night40Amount)
        const soRef = addStat('Sonntagszuschlag 50 %', COLS.so50, s.sunday50, 0.5, s.sunday50Amount)
        const feRef = addStat('Feiertagszuschlag 125 %', COLS.fe125, s.holiday125, 1.25, s.holiday125Amount)

        const bruttoRow = sheet.addRow(['Bruttolohn (geschätzt)'])
        bruttoRow.getCell(1).font = { bold: true }
        sheet.mergeCells(bruttoRow.number, 1, bruttoRow.number, 3)
        const bruttoCell = bruttoRow.getCell(4)
        bruttoCell.value = { formula: `${nettoRef}*${rateRef}+${soRef}*${rateRef}*0.5+${feRef}*${rateRef}*1.25`, result: s.grossWage ?? 0 }
        bruttoCell.numFmt = '0.00 "EUR"'; bruttoCell.font = { bold: true }
        perDriverBruttoRefs.push(`${L(4)}${bruttoRow.number}`)
        sheet.addRow([])
      })

      if (perDriverBruttoRefs.length > 1) {
        const gRow = sheet.addRow(['Bruttolohn gesamt (alle Fahrer)']); gRow.getCell(1).font = { bold: true }
        sheet.mergeCells(gRow.number, 1, gRow.number, 3)
        const gCell = gRow.getCell(4)
        gCell.value = { formula: perDriverBruttoRefs.join('+'), result: 0 }
        gCell.numFmt = '0.00 "EUR"'; gCell.font = { bold: true }
      }
    }

    // Erläuterung unter die Zusammenfassung
    sheet.addRow([])
    const note = sheet.addRow([
      'Gelbe Felder (Beginn, Ende, Pause, Weg) sind editierbar - alle übrigen Spalten (Netto, Gesamt, Ruhezeit, Zuschläge) und die Zusammenfassung sind Formeln und berechnen sich beim Ändern automatisch neu. Netto = (Ende−Beginn)×24 − Pause/60. Ruhezeit = (Beginn − Ende der vorherigen Schicht)×24 (gesetzliches Minimum i. d. R. 11 Std., § 5 ArbZG). Zuschläge nach § 3b EStG: Nacht 25% (04-06 & 20-24 Uhr), Nacht 40% steuerfrei (00-04 Uhr), Sonntag 50%, Feiertag 125% - jeweils Anwesenheit minus Pause.'
    ])
    note.font = { italic: true, size: 9, color: { argb: 'FF666666' } }
    sheet.mergeCells(note.number, 1, note.number, nCols)
    note.getCell(1).alignment = { wrapText: true }

    // Sicherstellen, dass ALLE Zellen linksbündig sind (Zahlen/Datum wären
    // sonst rechtsbündig) - vorhandene Ausrichtung (z. B. Zeilenumbruch)
    // bleibt erhalten, nur die horizontale Ausrichtung wird auf links gesetzt.
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.alignment = { ...(cell.alignment ?? {}), horizontal: 'left' }
      })
    })

    const buffer = await workbook.xlsx.writeBuffer()
    return new NextResponse(Buffer.from(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="dienstplan.xlsx"'
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
