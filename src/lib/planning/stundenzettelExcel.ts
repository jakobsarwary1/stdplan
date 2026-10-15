import ExcelJS from 'exceljs'

/** Eine Tageszeile im Stundenzettel. Freie Tage bleiben in Von/Bis leer. */
export type StundenzettelRow = {
  driverName: string
  employeeNumber?: string | null
  date: string
  isoDate: string
  startMin: number
  endMin: number
  breakOffsetMin: number
  breakMinutes: number
  commuteMinutes: number
  netHours: number
  paidHours: number
  totalHours: number
  vehiclePlate: string
  night25: number
  night40: number
  sunday50: number
  holiday125: number
  isFree?: boolean
  freeLabel?: string | null
}

export type StundenzettelSummary = {
  driverName: string
  paidHours: number
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

function excelSerial(isoDate: string, minutes: number): number {
  const [y, m, d] = isoDate.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + minutes * 60000
  return ms / 86400000 + 25569
}

function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function ov2day(a: number, b: number, w1: number, w2: number): number {
  const D = Math.floor(a)
  return Math.max(0, Math.min(b, D + w2) - Math.max(a, D + w1))
    + Math.max(0, Math.min(b, D + 1 + w2) - Math.max(a, D + 1 + w1))
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

/**
 * Dasselbe Blatt wie der Monats-Stundenzettel: Dienstplan mit Von/Bis,
 * Pausenminuten, Formelspalten und Monatszusammenfassung je Fahrer.
 */
export type StundenzettelInput = {
  rows: StundenzettelRow[]
  summaries: StundenzettelSummary[]
  monthLabel?: string
  companyName?: string
  title?: string
  holidayDates?: string[]
  sheetName?: string
}

export async function buildStundenzettelWorkbook(input: StundenzettelInput): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'FleetOS'
  workbook.created = new Date()
  workbook.calcProperties.fullCalcOnLoad = true
  await addStundenzettelSheet(workbook, input)
  return workbook
}

/**
 * Fügt einem Workbook EIN Dienstplan-Blatt im Standard-Design hinzu
 * (für Arbeitsmappen mit mehreren Blättern, z. B. ein Blatt je Fahrer).
 */
export async function addStundenzettelSheet(
  workbook: ExcelJS.Workbook,
  input: StundenzettelInput,
): Promise<ExcelJS.Worksheet> {
  const { rows, summaries } = input
  const title = input.title || 'Stundenzettel'
  const companyName = input.companyName
  const monthLabel = input.monthLabel
  const holidaySerials = (input.holidayDates ?? []).map((iso) => Math.floor(excelSerial(iso, 0)))
  const holidaySerialSet = new Set<number>(holidaySerials)

  const COLS = {
    fahrer: 1, datum: 2, von: 3, bis: 4, beginn: 5, ende: 6, pause: 7, weg: 8,
    netto: 9, ruhe: 10, n25: 11, n40: 12, so50: 13, fe125: 14,
    hinweis: 15, pOffset: 16, pBeginn: 17, pEnde: 18,
  }
  const HEADERS: [number, string, number][] = [
    [COLS.fahrer, 'Fahrer', 14], [COLS.datum, 'Datum', 14],
    [COLS.von, 'Von', 8], [COLS.bis, 'Bis', 8],
    [COLS.beginn, 'Beginn', 16], [COLS.ende, 'Ende', 16],
    [COLS.pause, 'Pause', 12], [COLS.weg, 'Weg (Min.)', 8],
    [COLS.netto, 'Bezahlt (Std.)', 10],
    [COLS.ruhe, 'Ruhezeit (Std.)', 10],
    [COLS.n25, 'Nacht 25%', 8], [COLS.n40, 'Nacht 40%', 8],
    [COLS.so50, 'Sonntag 50%', 8], [COLS.fe125, 'Feiertag 125%', 9],
    [COLS.hinweis, 'Hinweis', 18],
    [COLS.pOffset, 'Pausenlage (Hilfsspalte)', 22],
    [COLS.pBeginn, 'Pause-Beginn (Hilfsspalte)', 16],
    [COLS.pEnde, 'Pause-Ende (Hilfsspalte)', 16],
  ]
  const nCols = HEADERS.length
  const L = (c: number) => colLetter(c)

  const sheet = workbook.addWorksheet(input.sheetName || 'Dienstplan', {
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  })
  HEADERS.forEach(([, , w], i) => {
    sheet.getColumn(i + 1).width = w
    sheet.getColumn(i + 1).alignment = { horizontal: 'left' }
  })

  const workRows = rows.filter((r) => !r.isFree)
  const persNrByName = new Map(workRows.map((r) => [r.driverName, r.employeeNumber ?? null]))
  const titleParts = [title, companyName, monthLabel].filter(Boolean)
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

  const DT = 'dd.mm.yy hh:mm'
  const inputFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } }

  const ov = (a: string, b: string, w1: string, w2: string) =>
    `MAX(0,MIN(${b},INT(${a})+${w2})-MAX(${a},INT(${a})+${w1}))+MAX(0,MIN(${b},INT(${a})+1+${w2})-MAX(${a},INT(${a})+1+${w1}))`
  const fullSun = (a: string, b: string) =>
    `(WEEKDAY(INT(${a}),2)=7)*MAX(0,MIN(${b},INT(${a})+1)-MAX(${a},INT(${a})))+(WEEKDAY(INT(${a})+1,2)=7)*MAX(0,MIN(${b},INT(${a})+2)-MAX(${a},INT(${a})+1))`
  const holGate = (dd: string) =>
    holidaySerials.length === 0 ? '0' : `(OR(${holidaySerials.map((s) => `INT(${dd})=${s}`).join(',')}))*(WEEKDAY(${dd},2)<>7)`
  const fullHol = (a: string, b: string) =>
    holidaySerials.length === 0 ? '0'
      : `(${holGate(`INT(${a})`)})*MAX(0,MIN(${b},INT(${a})+1)-MAX(${a},INT(${a})))+(${holGate(`INT(${a})+1`)})*MAX(0,MIN(${b},INT(${a})+2)-MAX(${a},INT(${a})+1))`

  let firstDataRow = 0
  let lastDataRow = 0
  let prevWorkEndeRow = 0
  let prevWorkEndeSerial = 0
  const wennGefuellt = (R: number, formel: string) =>
    `IF(OR($${L(COLS.von)}${R}="",$${L(COLS.bis)}${R}=""),"",${formel})`

  rows.forEach((r) => {
    const frei = !!r.isFree
    const R = sheet.addRow([r.driverName]).number
    if (firstDataRow === 0) firstDataRow = R
    lastDataRow = R
    const cell = (c: number) => sheet.getCell(R, c)
    if (frei) sheet.getRow(R).font = { color: { argb: 'FF999999' }, italic: true }

    const beginnSerial = excelSerial(r.isoDate, r.startMin)
    const endeSerial = excelSerial(r.isoDate, r.endMin)
    const tagSerial = excelSerial(r.isoDate, 0)
    const unlocked = { locked: false }
    const cVonIn = cell(COLS.von)
    cVonIn.value = frei ? null : (beginnSerial - tagSerial)
    cVonIn.numFmt = 'hh:mm'
    cVonIn.fill = inputFill
    cVonIn.protection = unlocked
    const cBisIn = cell(COLS.bis)
    cBisIn.value = frei ? null : ((endeSerial - tagSerial) % 1)
    cBisIn.numFmt = 'hh:mm'
    cBisIn.fill = inputFill
    cBisIn.protection = unlocked
    const cP = cell(COLS.pause)
    cP.value = frei ? null : r.breakMinutes / 60
    cP.numFmt = '0.##" h"'
    cP.fill = inputFill
    cP.protection = unlocked
    const cW = cell(COLS.weg)
    cW.value = frei ? null : r.commuteMinutes
    cW.numFmt = '0'
    cW.fill = inputFill
    cW.protection = unlocked
    const cO = cell(COLS.pOffset)
    cO.value = frei ? 0 : r.breakOffsetMin
    cO.numFmt = '0'
    cO.fill = inputFill
    cO.protection = unlocked

    const bRef = `${L(COLS.beginn)}${R}`
    const eRef = `${L(COLS.ende)}${R}`
    const pRef = `${L(COLS.pause)}${R}`
    const oRef = `${L(COLS.pOffset)}${R}`
    const pbRef = `${L(COLS.pBeginn)}${R}`
    const peRef = `${L(COLS.pEnde)}${R}`
    const dRef = `${L(COLS.datum)}${R}`
    const vRef = `${L(COLS.von)}${R}`
    const bisRef = `${L(COLS.bis)}${R}`
    const cD = cell(COLS.datum)
    cD.value = tagSerial
    cD.numFmt = 'ddd dd.mm.yy'

    const cB = cell(COLS.beginn)
    cB.value = { formula: wennGefuellt(R, `${dRef}+${vRef}`), result: frei ? '' : beginnSerial }
    cB.numFmt = DT
    const cE = cell(COLS.ende)
    cE.value = { formula: wennGefuellt(R, `${dRef}+${bisRef}+IF(${bisRef}<=${vRef},1,0)`), result: frei ? '' : endeSerial }
    cE.numFmt = DT

    if (r.freeLabel) cell(COLS.hinweis).value = r.freeLabel

    const pbSerial = excelSerial(r.isoDate, r.startMin + r.breakOffsetMin)
    const peSerial = excelSerial(r.isoDate, r.startMin + r.breakOffsetMin + r.breakMinutes)
    const cPB = cell(COLS.pBeginn)
    cPB.value = { formula: wennGefuellt(R, `${bRef}+${oRef}/1440`), result: frei ? '' : pbSerial }
    cPB.numFmt = DT
    const cPE = cell(COLS.pEnde)
    cPE.value = { formula: wennGefuellt(R, `${pbRef}+${pRef}/24`), result: frei ? '' : peSerial }
    cPE.numFmt = DT

    const cN = cell(COLS.netto)
    cN.value = { formula: wennGefuellt(R, `(${eRef}-${bRef})*24`), result: frei ? '' : r.paidHours }
    cN.numFmt = '0.00'

    const cR = cell(COLS.ruhe)
    if (prevWorkEndeRow > 0) {
      cR.value = {
        formula: wennGefuellt(R, `(${bRef}-${L(COLS.ende)}${prevWorkEndeRow})*24`),
        result: frei ? '' : (beginnSerial - prevWorkEndeSerial) * 24,
      }
    }
    cR.numFmt = '0.00'

    const n40 = (ov2day(beginnSerial, endeSerial, 0, 4 / 24) - ov2day(pbSerial, peSerial, 0, 4 / 24)) * 24
    const n25 = ((ov2day(beginnSerial, endeSerial, 4 / 24, 6 / 24) + ov2day(beginnSerial, endeSerial, 20 / 24, 1))
      - (ov2day(pbSerial, peSerial, 4 / 24, 6 / 24) + ov2day(pbSerial, peSerial, 20 / 24, 1))) * 24
    const so50 = (fullDay(beginnSerial, endeSerial, true, holidaySerialSet) - fullDay(pbSerial, peSerial, true, holidaySerialSet)) * 24
    const fe125 = (fullDay(beginnSerial, endeSerial, false, holidaySerialSet) - fullDay(pbSerial, peSerial, false, holidaySerialSet)) * 24

    const cN25 = cell(COLS.n25)
    cN25.value = {
      formula: wennGefuellt(R, `((${ov(bRef, eRef, '4/24', '6/24')})+(${ov(bRef, eRef, '20/24', '1')})-((${ov(pbRef, peRef, '4/24', '6/24')})+(${ov(pbRef, peRef, '20/24', '1')})))*24`),
      result: frei ? '' : n25,
    }
    cN25.numFmt = '0.00'
    const cN40 = cell(COLS.n40)
    cN40.value = {
      formula: wennGefuellt(R, `((${ov(bRef, eRef, '0', '4/24')})-(${ov(pbRef, peRef, '0', '4/24')}))*24`),
      result: frei ? '' : n40,
    }
    cN40.numFmt = '0.00'
    const cSo = cell(COLS.so50)
    cSo.value = {
      formula: wennGefuellt(R, `((${fullSun(bRef, eRef)})-(${fullSun(pbRef, peRef)}))*24`),
      result: frei ? '' : so50,
    }
    cSo.numFmt = '0.00'
    const cFe = cell(COLS.fe125)
    cFe.value = {
      formula: wennGefuellt(R, `((${fullHol(bRef, eRef)})-(${fullHol(pbRef, peRef)}))*24`),
      result: frei ? '' : fe125,
    }
    cFe.numFmt = '0.00'

    if (!frei) {
      prevWorkEndeRow = R
      prevWorkEndeSerial = endeSerial
    }
  })

  sheet.getColumn(COLS.pOffset).hidden = true
  sheet.getColumn(COLS.pBeginn).hidden = true
  sheet.getColumn(COLS.pEnde).hidden = true

  if (summaries && summaries.length > 0 && lastDataRow >= firstDataRow) {
    const colRange = (c: number) => `$${L(c)}$${firstDataRow}:$${L(c)}$${lastDataRow}`
    const fahrerRange = `$${L(COLS.fahrer)}$${firstDataRow}:$${L(COLS.fahrer)}$${lastDataRow}`

    const spacer = sheet.addRow([])
    spacer.addPageBreak()
    const head = sheet.addRow(['Monatszusammenfassung'])
    head.font = { bold: true, size: 13 }

    const perDriverBruttoRefs: string[] = []
    summaries.filter((s) => s.driverName !== 'Gesamt (alle Fahrer)').forEach((s) => {
      const nameRow = sheet.addRow([s.driverName])
      nameRow.getCell(1).font = { bold: true, size: 12 }
      const nameRef = `$${L(COLS.fahrer)}$${nameRow.number}`
      const persNr = persNrByName.get(s.driverName)
      if (persNr) {
        const pnRow = sheet.addRow([`Pers.-Nr.: ${persNr}`])
        sheet.mergeCells(pnRow.number, 1, pnRow.number, 5)
      }

      const LABEL_TO = 3
      const STD_COL = 4
      const STD_TO = 5
      const AMT_COL = 6
      const AMT_TO = 8

      const rateRow = sheet.addRow(['Stundenlohn (EUR)'])
      sheet.mergeCells(rateRow.number, 1, rateRow.number, LABEL_TO)
      sheet.mergeCells(rateRow.number, STD_COL, rateRow.number, STD_TO)
      const rateCell = rateRow.getCell(STD_COL)
      rateCell.value = s.hourlyRate ?? null
      rateCell.numFmt = '0.00'
      rateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } }
      rateCell.protection = { locked: false }
      const rateRef = `$${L(STD_COL)}$${rateRow.number}`

      const addStat = (label: string, col: number, result: number, factor: number | null, amountResult: number | null | undefined) => {
        const row = sheet.addRow([label])
        sheet.mergeCells(row.number, 1, row.number, LABEL_TO)
        sheet.mergeCells(row.number, STD_COL, row.number, STD_TO)
        const stdCell = row.getCell(STD_COL)
        stdCell.value = { formula: `SUMIFS(${colRange(col)},${fahrerRange},${nameRef})`, result }
        stdCell.numFmt = '0.00'
        if (factor != null) {
          sheet.mergeCells(row.number, AMT_COL, row.number, AMT_TO)
          const amtCell = row.getCell(AMT_COL)
          amtCell.value = { formula: `${L(STD_COL)}${row.number}*${rateRef}*${factor}`, result: amountResult ?? 0 }
          amtCell.numFmt = '0.00 "EUR"'
        }
        return `${L(STD_COL)}${row.number}`
      }
      const nettoRef = addStat('Bezahlt (Std.)', COLS.netto, s.paidHours, null, null)

      const krankRow = sheet.addRow(['Krank (Std.)'])
      sheet.mergeCells(krankRow.number, 1, krankRow.number, LABEL_TO)
      sheet.mergeCells(krankRow.number, STD_COL, krankRow.number, STD_TO)
      const krankCell = krankRow.getCell(STD_COL)
      krankCell.value = s.sickHours ?? 0
      krankCell.numFmt = '0.00'
      krankCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } }
      krankCell.protection = { locked: false }
      const krankRef = `${L(STD_COL)}${krankRow.number}`

      const gesamtRow = sheet.addRow(['Gesamt inkl. Krank (Std.)'])
      gesamtRow.getCell(1).font = { bold: true }
      sheet.mergeCells(gesamtRow.number, 1, gesamtRow.number, LABEL_TO)
      sheet.mergeCells(gesamtRow.number, STD_COL, gesamtRow.number, STD_TO)
      const gesamtCell = gesamtRow.getCell(STD_COL)
      gesamtCell.value = { formula: `${nettoRef}+${krankRef}`, result: s.paidHours + (s.sickHours ?? 0) }
      gesamtCell.numFmt = '0.00'
      gesamtCell.font = { bold: true }

      const zHead = sheet.addRow(['Zuschläge – Aufschläge auf dieselben Stunden (Mehrfachzuschlag möglich, Summe daher höher als Netto)'])
      sheet.mergeCells(zHead.number, 1, zHead.number, AMT_TO)
      zHead.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF666666' } }
      zHead.getCell(1).alignment = { wrapText: true }
      const n25Ref = addStat('Nachtzuschlag 25 %', COLS.n25, s.night25, 0.25, s.night25Amount)
      const n40Ref = addStat('Nachtzuschlag 40 % steuerfrei', COLS.n40, s.night40, 0.4, s.night40Amount)
      const soRef = addStat('Sonntagszuschlag 50 %', COLS.so50, s.sunday50, 0.5, s.sunday50Amount)
      const feRef = addStat('Feiertagszuschlag 125 %', COLS.fe125, s.holiday125, 1.25, s.holiday125Amount)

      const bruttoRow = sheet.addRow(['Lohn gesamt (brutto, geschätzt)'])
      bruttoRow.getCell(1).font = { bold: true }
      sheet.mergeCells(bruttoRow.number, 1, bruttoRow.number, LABEL_TO)
      sheet.mergeCells(bruttoRow.number, STD_COL, bruttoRow.number, AMT_TO)
      const bruttoCell = bruttoRow.getCell(STD_COL)
      bruttoCell.value = {
        formula:
          `(${nettoRef}+${krankRef})*${rateRef}` +
          `+${n25Ref}*${rateRef}*0.25+${n40Ref}*${rateRef}*0.4` +
          `+${soRef}*${rateRef}*0.5+${feRef}*${rateRef}*1.25`,
        result: s.grossWage ?? 0,
      }
      bruttoCell.numFmt = '0.00 "EUR"'
      bruttoCell.font = { bold: true }
      perDriverBruttoRefs.push(`${L(STD_COL)}${bruttoRow.number}`)
      sheet.addRow([])
    })

    if (perDriverBruttoRefs.length > 1) {
      const gRow = sheet.addRow(['Bruttolohn gesamt (alle Fahrer)'])
      gRow.getCell(1).font = { bold: true }
      sheet.mergeCells(gRow.number, 1, gRow.number, 3)
      sheet.mergeCells(gRow.number, 4, gRow.number, 8)
      const gCell = gRow.getCell(4)
      gCell.value = { formula: perDriverBruttoRefs.join('+'), result: 0 }
      gCell.numFmt = '0.00 "EUR"'
      gCell.font = { bold: true }
    }
  }

  sheet.addRow([])
  const note = sheet.addRow([
    'Gelbe Felder (Von, Bis, Pause, Weg) sind editierbar - alle übrigen Spalten (Beginn/Ende, Bezahlt, Ruhezeit, Zuschläge) und die Zusammenfassung sind Formeln und berechnen sich beim Ändern automatisch neu. Uhrzeiten werden in Von/Bis eingetragen (z. B. 05:00); Beginn/Ende ergeben sich daraus als Datum + Uhrzeit. Endet die Schicht rechnerisch vor ihrem Beginn (z. B. 21:00 bis 05:00), zählt das Ende automatisch auf den Folgetag. Auch an freien Tagen sind alle Formeln vorhanden: Zeiten eintragen genügt. Bezahlt = (Ende−Beginn)×24 – die Pause ist bezahlt (kein Abzug), der Arbeitsweg (Weg) zählt nie mit. Ruhezeit = (Beginn − Ende der vorherigen Schicht)×24 (gesetzliches Minimum i. d. R. 11 Std., § 5 ArbZG). Zuschläge nach § 3b EStG: Nacht 25% (04-06 & 20-24 Uhr), Nacht 40% steuerfrei (00-04 Uhr), Sonntag 50%, Feiertag 125% - jeweils reine Arbeitszeit ohne Pause (die Pause ist keine Arbeitszeit und bekommt keinen Zuschlag). Die Zuschlagsstunden überschneiden sich (eine Sonntagnacht-Stunde zählt z. B. bei Nacht UND Sonntag) und ergeben in Summe bewusst mehr als die reine Arbeitszeit; im Grundlohn wird jede bezahlte Stunde nur EINMAL (100%) gezählt, die Zuschläge sind reine prozentuale Aufschläge. Lohn gesamt = (Bezahlt + Krank) × Stundenlohn plus alle vier Zuschläge; die Nachtzuschläge sind steuerfrei, werden aber ausgezahlt und zählen deshalb mit. — Zum Schutz vor versehentlichen Fehlern ist das Blatt gesperrt: NUR die gelben Felder lassen sich bearbeiten. Der Schutz kann bei Bedarf über „Überprüfen › Blattschutz aufheben" (ohne Passwort) entfernt werden.',
  ])
  note.font = { italic: true, size: 9, color: { argb: 'FF666666' } }
  sheet.mergeCells(note.number, 1, note.number, nCols)
  note.getCell(1).alignment = { wrapText: true }

  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.alignment = { ...(cell.alignment ?? {}), horizontal: 'left' }
    })
  })

  await sheet.protect('', {
    selectLockedCells: true, selectUnlockedCells: true,
    formatCells: false, formatColumns: false, formatRows: false,
    insertColumns: false, insertRows: false, insertHyperlinks: false,
    deleteColumns: false, deleteRows: false, sort: false, autoFilter: false, pivotTables: false,
  })

  return sheet
}
