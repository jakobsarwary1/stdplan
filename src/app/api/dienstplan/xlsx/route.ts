import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { getCurrentUser } from '@/lib/auth'
import { verteileExakt, type ExactShift } from '@/lib/planning/exact'
import { berechneManuell, type DayInput } from '@/lib/planning/manual'
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
        shifts = verteileExakt(year, month, {
          bezahlt: total, sunday: Number(dr.sunday) || 0,
          n25: Number(dr.night25) || 0, n40: Number(dr.night40) || 0,
        }).shifts
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

    const title = 'Stundenzettel'
    const vehiclePlate: string | undefined = undefined
    const { rows, summaries } = buildPlan(driverRows, year, month)
    if (rows.length === 0) return NextResponse.json({ error: 'Kein Fahrer mit Stunden eingetragen.' }, { status: 400 })

    const holidaySerials: number[] = []
    const holidaySerialSet = new Set<number>()

    // ---- Spaltenlayout (fest, alle Felder sind Formeln außer den
    // Eingabefeldern Beginn/Ende/Pause/Weg/Pause-Offset) ----
    const COLS = {
      fahrer: 1, datum: 2, von: 3, bis: 4, beginn: 5, ende: 6, pause: 7, weg: 8,
      netto: 9, ruhe: 10, n25: 11, n40: 12, so50: 13, fe125: 14,
      hinweis: 15, pOffset: 16, pBeginn: 17, pEnde: 18
    }
    const HEADERS: [number, string, number][] = [
      [COLS.fahrer, 'Fahrer', 14], [COLS.datum, 'Datum', 14],
      [COLS.von, 'Von', 8], [COLS.bis, 'Bis', 8],
      [COLS.beginn, 'Beginn', 16], [COLS.ende, 'Ende', 16],
      [COLS.pause, 'Pause (Min.)', 9], [COLS.weg, 'Weg (Min.)', 8],
      [COLS.netto, 'Bezahlt (Std.)', 10],
      [COLS.ruhe, 'Ruhezeit (Std.)', 10],
      [COLS.n25, 'Nacht 25%', 8], [COLS.n40, 'Nacht 40%', 8],
      [COLS.so50, 'Sonntag 50%', 8], [COLS.fe125, 'Feiertag 125%', 9],
      [COLS.hinweis, 'Hinweis', 18], [COLS.pOffset, 'Pausenlage (Hilfsspalte)', 22], [COLS.pBeginn, 'Pause-Beginn (Hilfsspalte)', 16], [COLS.pEnde, 'Pause-Ende (Hilfsspalte)', 16]
    ]
    const nCols = HEADERS.length
    const L = (c: number) => colLetter(c)

    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'FleetOS'
    workbook.created = new Date()
    workbook.calcProperties.fullCalcOnLoad = true // erzwingt Neuberechnung beim Öffnen

    const sheet = workbook.addWorksheet('Dienstplan', {
      // Auf A4 quer, auf Seitenbreite skaliert (eine Seite breit, beliebig
      // viele Seiten hoch), schmale Ränder - für einen übersichtlichen
      // Ausdruck.
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        horizontalCentered: true, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
      }
    })
    // Hinweis: KEINE Wiederholung der Kopfzeile auf jeder Druckseite
    // (printTitlesRow) - sonst würde die Spaltenüberschrift der
    // Schichttabelle auch auf der (per Seitenumbruch getrennten)
    // Monatszusammenfassung erscheinen, was dort nur verwirrt.
    // Alle Spalten linksbündig (Excel würde Zahlen/Datum sonst rechtsbündig
    // ausrichten).
    HEADERS.forEach(([c, , w]) => { sheet.getColumn(c).width = w; sheet.getColumn(c).alignment = { horizontal: 'left' } })

    // Voller Name (Vor- und Nachname) + Personalnummer des/der Fahrer(s)
    // für die Überschrift.
    const workRows = rows.filter((r) => !r.isFree)
    const driverKeys = Array.from(new Set(workRows.map((r) => r.driverName)))
    const persNrByName = new Map(workRows.map((r) => [r.driverName, r.employeeNumber ?? null]))
    const driverLabels = driverKeys.map((name) => {
      const nr = persNrByName.get(name)
      return nr ? `${name} (Pers.-Nr.: ${nr})` : name
    })
    void driverLabels
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

    // Jede Zeile - auch ein freier Tag - bekommt denselben Formelsatz. Wer an
    // einem als frei geplanten Tag doch gefahren ist, traegt einfach Beginn
    // und Ende ein; Netto, Gesamt, Ruhezeit, alle Zuschlaege und die
    // Monatssummen rechnen sich sofort mit. Solange Beginn oder Ende leer
    // sind, liefern die Formeln "" - die Zeile bleibt also optisch leer,
    // statt ueberall 0,00 zu zeigen.
    const wennGefuellt = (R: number, formel: string) =>
      `IF(OR($${L(COLS.von)}${R}="",$${L(COLS.bis)}${R}=""),"",${formel})`

    rows.forEach((r) => {
      const frei = !!r.isFree
      const R = sheet.addRow([r.driverName]).number
      if (firstDataRow === 0) firstDataRow = R
      lastDataRow = R
      const cell = (c: number) => sheet.getCell(R, c)
      if (frei) sheet.getRow(R).font = { color: { argb: 'FF999999' }, italic: true }

      // Eingabefelder - bei freien Tagen leer, aber gelb und beschreibbar.
      //
      // Getippt wird in VON und BIS (reine Uhrzeit, so wie auf dem
      // Papier-Dienstplan). Beginn/Ende sind daraus abgeleitete Formeln mit
      // Datum - frueher war es umgekehrt, und wer die Uhrzeit in "Von"
      // aenderte, aenderte damit gar nichts: die Spalte war nur eine Anzeige
      // von "Beginn". Laeuft die Schicht ueber Mitternacht (Bis <= Von),
      // zaehlt das Ende automatisch einen Tag weiter.
      const beginnSerial = excelSerial(r.isoDate, r.startMin)
      const endeSerial = excelSerial(r.isoDate, r.endMin)
      const tagSerial = excelSerial(r.isoDate, 0)
      const unlocked = { locked: false } // nur diese Felder bleiben bei aktivem Blattschutz editierbar
      const cVonIn = cell(COLS.von)
      cVonIn.value = frei ? null : (beginnSerial - tagSerial)
      cVonIn.numFmt = 'hh:mm'; cVonIn.fill = inputFill; cVonIn.protection = unlocked
      const cBisIn = cell(COLS.bis)
      // Bis als Uhrzeit innerhalb des Tages; eine Nachtschicht endet z. B. um 05:00.
      cBisIn.value = frei ? null : ((endeSerial - tagSerial) % 1)
      cBisIn.numFmt = 'hh:mm'; cBisIn.fill = inputFill; cBisIn.protection = unlocked
      const cP = cell(COLS.pause); cP.value = frei ? null : r.breakMinutes; cP.numFmt = '0'; cP.fill = inputFill; cP.protection = unlocked
      const cW = cell(COLS.weg); cW.value = frei ? null : r.commuteMinutes; cW.numFmt = '0'; cW.fill = inputFill; cW.protection = unlocked
      // Pausenlage bleibt (als versteckte Hilfsspalte) ebenfalls editierbar,
      // falls jemand die Pause bewusst verschieben will.
      const cO = cell(COLS.pOffset); cO.value = frei ? 0 : r.breakOffsetMin; cO.numFmt = '0'; cO.fill = inputFill; cO.protection = unlocked

      const bRef = `${L(COLS.beginn)}${R}`, eRef = `${L(COLS.ende)}${R}`
      const pRef = `${L(COLS.pause)}${R}`, oRef = `${L(COLS.pOffset)}${R}`
      const pbRef = `${L(COLS.pBeginn)}${R}`, peRef = `${L(COLS.pEnde)}${R}`

      // Datum: fester Kalendertag der Zeile - er ist die Grundlage fuer
      // Beginn/Ende und steht auch an freien Tagen da.
      const dRef = `${L(COLS.datum)}${R}`, vRef = `${L(COLS.von)}${R}`, bisRef = `${L(COLS.bis)}${R}`
      const cD = cell(COLS.datum); cD.value = tagSerial; cD.numFmt = 'ddd dd.mm.yy'

      // Beginn/Ende = Datum + getippte Uhrzeit. Endet die Schicht rechnerisch
      // vor ihrem Beginn, laeuft sie ueber Mitternacht und das Ende faellt auf
      // den Folgetag.
      const cB = cell(COLS.beginn)
      cB.value = { formula: wennGefuellt(R, `${dRef}+${vRef}`), result: frei ? '' : beginnSerial }
      cB.numFmt = DT
      const cE = cell(COLS.ende)
      cE.value = { formula: wennGefuellt(R, `${dRef}+${bisRef}+IF(${bisRef}<=${vRef},1,0)`), result: frei ? '' : endeSerial }
      cE.numFmt = DT

      // Grund der Abwesenheit ganz rechts, damit er keine Rechenspalte belegt.
      if (r.freeLabel) cell(COLS.hinweis).value = r.freeLabel

      // Pause-Beginn / Pause-Ende (Hilfsspalten für die Zuschlagsformeln)
      const pbSerial = excelSerial(r.isoDate, r.startMin + r.breakOffsetMin)
      const peSerial = excelSerial(r.isoDate, r.startMin + r.breakOffsetMin + r.breakMinutes)
      const cPB = cell(COLS.pBeginn); cPB.value = { formula: wennGefuellt(R, `${bRef}+${oRef}/1440`), result: frei ? '' : pbSerial }; cPB.numFmt = DT
      const cPE = cell(COLS.pEnde); cPE.value = { formula: wennGefuellt(R, `${pbRef}+${pRef}/1440`), result: frei ? '' : peSerial }; cPE.numFmt = DT

      // Bezahlt = Schichtspanne Beginn→Ende. Die Pause ist BEZAHLT und bleibt
      // drin (kein Abzug); der Arbeitsweg ("Weg") ist NIE bezahlt und zaehlt
      // NIE mit. Der Lohn rechnet genau auf dieser Spalte.
      const cN = cell(COLS.netto); cN.value = { formula: wennGefuellt(R, `(${eRef}-${bRef})*24`), result: frei ? '' : r.paidHours }; cN.numFmt = '0.00'

      // Ruhezeit gegenüber der vorherigen Arbeitsschicht
      const cR = cell(COLS.ruhe)
      if (prevWorkEndeRow > 0) {
        cR.value = {
          formula: wennGefuellt(R, `(${bRef}-${L(COLS.ende)}${prevWorkEndeRow})*24`),
          result: frei ? '' : (beginnSerial - prevWorkEndeSerial) * 24
        }
      }
      cR.numFmt = '0.00'

      // Zuschläge (Formel = Überlappung Schicht − Überlappung Pause)
      const n40 = (ov2day(beginnSerial, endeSerial, 0, 4 / 24) - ov2day(pbSerial, peSerial, 0, 4 / 24)) * 24
      const n25 = ((ov2day(beginnSerial, endeSerial, 4 / 24, 6 / 24) + ov2day(beginnSerial, endeSerial, 20 / 24, 1))
        - (ov2day(pbSerial, peSerial, 4 / 24, 6 / 24) + ov2day(pbSerial, peSerial, 20 / 24, 1))) * 24
      const so50 = (fullDay(beginnSerial, endeSerial, true, holidaySerialSet) - fullDay(pbSerial, peSerial, true, holidaySerialSet)) * 24
      const fe125 = (fullDay(beginnSerial, endeSerial, false, holidaySerialSet) - fullDay(pbSerial, peSerial, false, holidaySerialSet)) * 24

      const cN25 = cell(COLS.n25)
      cN25.value = { formula: wennGefuellt(R, `((${ov(bRef, eRef, '4/24', '6/24')})+(${ov(bRef, eRef, '20/24', '1')})-((${ov(pbRef, peRef, '4/24', '6/24')})+(${ov(pbRef, peRef, '20/24', '1')})))*24`), result: frei ? '' : n25 }
      cN25.numFmt = '0.00'
      const cN40 = cell(COLS.n40)
      cN40.value = { formula: wennGefuellt(R, `((${ov(bRef, eRef, '0', '4/24')})-(${ov(pbRef, peRef, '0', '4/24')}))*24`), result: frei ? '' : n40 }
      cN40.numFmt = '0.00'
      const cSo = cell(COLS.so50)
      cSo.value = { formula: wennGefuellt(R, `((${fullSun(bRef, eRef)})-(${fullSun(pbRef, peRef)}))*24`), result: frei ? '' : so50 }
      cSo.numFmt = '0.00'
      const cFe = cell(COLS.fe125)
      cFe.value = { formula: wennGefuellt(R, `((${fullHol(bRef, eRef)})-(${fullHol(pbRef, peRef)}))*24`), result: frei ? '' : fe125 }
      cFe.numFmt = '0.00'

      // Freie Tage geben die Ruhezeit-Kette nicht weiter - sie haben ja
      // (noch) keine Zeiten.
      if (!frei) { prevWorkEndeRow = R; prevWorkEndeSerial = endeSerial }
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

      const spacer = sheet.addRow([])
      // Seitenumbruch nach dem Dienstplan: die Monatszusammenfassung wird
      // dadurch auf einer separaten Seite ausgedruckt.
      spacer.addPageBreak()
      const head = sheet.addRow(['Monatszusammenfassung']); head.font = { bold: true, size: 13 }

      const perDriverBruttoRefs: string[] = []
      summaries.filter((s) => s.driverName !== 'Gesamt (alle Fahrer)').forEach((s) => {
        // Voller Name MUSS allein in Spalte 1 stehen - die SUMIFS-Formeln
        // vergleichen genau diese Zelle mit der Fahrer-Spalte im Dienstplan
        // (voller Name statt Nachname, damit gleiche Nachnamen – z. B. Said und
        // Sara Schukrullahi – nicht zusammengezählt werden).
        const nameRow = sheet.addRow([s.driverName]); nameRow.getCell(1).font = { bold: true, size: 12 }
        const nameRef = `$${L(COLS.fahrer)}$${nameRow.number}`
        // Personalnummer als eigene Zeile darunter (beeinflusst die SUMIFS
        // nicht).
        const persNr = persNrByName.get(s.driverName)
        if (persNr) {
          const pnRow = sheet.addRow([`Pers.-Nr.: ${persNr}`])
          sheet.mergeCells(pnRow.number, 1, pnRow.number, 5)
        }

        // Zellen für die Zusammenfassung großzügig verbinden, damit die
        // (teils langen) Euro-Beträge nicht als "######" abgeschnitten
        // werden: Label = Spalten 1-3, Std.-Wert = Spalten 4-5, Betrag =
        // Spalten 6-8.
        const LABEL_TO = 3, STD_COL = 4, STD_TO = 5, AMT_COL = 6, AMT_TO = 8

        // Editierbarer Stundenlohn (Eingabefeld)
        const rateRow = sheet.addRow(['Stundenlohn (EUR)'])
        sheet.mergeCells(rateRow.number, 1, rateRow.number, LABEL_TO)
        sheet.mergeCells(rateRow.number, STD_COL, rateRow.number, STD_TO)
        const rateCell = rateRow.getCell(STD_COL)
        rateCell.value = s.hourlyRate ?? null
        rateCell.numFmt = '0.00'; rateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7D6' } }
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

        // Krankenstunden (Entgeltfortzahlung, § 3 EntgFG) stehen in keiner
        // Tagesspalte - daher als gelbes Eingabefeld, damit sie sich in der
        // Datei noch korrigieren lassen; Summe und Bruttolohn rechnen mit.
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

        // Zwischenueberschrift vor den Zuschlaegen: macht klar, dass die
        // folgenden Zuschlagsstunden AUFSCHLAEGE auf dieselben Stunden sind
        // (eine Sonntagnacht-Stunde zaehlt bei Nacht UND Sonntag), sich also
        // ueberschneiden. Ihre Summe liegt bewusst ueber der Netto-Arbeitszeit
        // und darf nicht als "Gesamtstunden" aufaddiert werden - der haeufigste
        // Irrtum beim Lesen des Blattes.
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
        // Grundlohn (inkl. Krankenstunden) plus SAEMTLICHE Zuschlaege - auch
        // die steuerfreien Nachtzuschlaege, die ja ebenfalls ausgezahlt werden.
        bruttoCell.value = {
          formula:
            `(${nettoRef}+${krankRef})*${rateRef}` +
            `+${n25Ref}*${rateRef}*0.25+${n40Ref}*${rateRef}*0.4` +
            `+${soRef}*${rateRef}*0.5+${feRef}*${rateRef}*1.25`,
          result: s.grossWage ?? 0
        }
        bruttoCell.numFmt = '0.00 "EUR"'; bruttoCell.font = { bold: true }
        perDriverBruttoRefs.push(`${L(STD_COL)}${bruttoRow.number}`)
        sheet.addRow([])
      })

      if (perDriverBruttoRefs.length > 1) {
        const gRow = sheet.addRow(['Bruttolohn gesamt (alle Fahrer)']); gRow.getCell(1).font = { bold: true }
        sheet.mergeCells(gRow.number, 1, gRow.number, 3)
        sheet.mergeCells(gRow.number, 4, gRow.number, 8)
        const gCell = gRow.getCell(4)
        gCell.value = { formula: perDriverBruttoRefs.join('+'), result: 0 }
        gCell.numFmt = '0.00 "EUR"'; gCell.font = { bold: true }
      }
    }

    // Erläuterung unter die Zusammenfassung
    sheet.addRow([])
    const note = sheet.addRow([
      'Gelbe Felder (Von, Bis, Pause, Weg) sind editierbar - alle übrigen Spalten (Beginn/Ende, Bezahlt, Ruhezeit, Zuschläge) und die Zusammenfassung sind Formeln und berechnen sich beim Ändern automatisch neu. Uhrzeiten werden in Von/Bis eingetragen (z. B. 05:00); Beginn/Ende ergeben sich daraus als Datum + Uhrzeit. Endet die Schicht rechnerisch vor ihrem Beginn (z. B. 21:00 bis 05:00), zählt das Ende automatisch auf den Folgetag. Auch an freien Tagen sind alle Formeln vorhanden: Zeiten eintragen genügt. Bezahlt = (Ende−Beginn)×24 – die Pause ist bezahlt (kein Abzug), der Arbeitsweg (Weg) zählt nie mit. Ruhezeit = (Beginn − Ende der vorherigen Schicht)×24 (gesetzliches Minimum i. d. R. 11 Std., § 5 ArbZG). Zuschläge nach § 3b EStG: Nacht 25% (04-06 & 20-24 Uhr), Nacht 40% steuerfrei (00-04 Uhr), Sonntag 50%, Feiertag 125% - jeweils reine Arbeitszeit ohne Pause (die Pause ist keine Arbeitszeit und bekommt keinen Zuschlag). Die Zuschlagsstunden überschneiden sich (eine Sonntagnacht-Stunde zählt z. B. bei Nacht UND Sonntag) und ergeben in Summe bewusst mehr als die reine Arbeitszeit; im Grundlohn wird jede bezahlte Stunde nur EINMAL (100%) gezählt, die Zuschläge sind reine prozentuale Aufschläge. Lohn gesamt = (Bezahlt + Krank) × Stundenlohn plus alle vier Zuschläge; die Nachtzuschläge sind steuerfrei, werden aber ausgezahlt und zählen deshalb mit.'
    ])
    note.font = { italic: true, size: 9, color: { argb: 'FF666666' } }
    sheet.mergeCells(note.number, 1, note.number, nCols)
    note.getCell(1).alignment = { wrapText: true }

    // Aktualisieren-Ergänzung im Hinweis (Blattschutz)
    note.getCell(1).value = `${note.getCell(1).value} — Zum Schutz vor versehentlichen Fehlern ist das Blatt gesperrt: NUR die gelben Felder lassen sich bearbeiten. Der Schutz kann bei Bedarf über „Überprüfen › Blattschutz aufheben" (ohne Passwort) entfernt werden.`

    // Sicherstellen, dass ALLE Zellen linksbündig sind (Zahlen/Datum wären
    // sonst rechtsbündig) - vorhandene Ausrichtung (z. B. Zeilenumbruch)
    // bleibt erhalten, nur die horizontale Ausrichtung wird auf links gesetzt.
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.alignment = { ...(cell.alignment ?? {}), horizontal: 'left' }
      })
    })

    // Blattschutz aktivieren: alle Zellen sind standardmäßig gesperrt, nur
    // die oben mit protection.locked = false markierten (gelben) Eingabe-
    // felder bleiben editierbar. Kein Passwort - der Schutz dient nur der
    // Fehlervermeidung und kann jederzeit ohne Passwort aufgehoben werden.
    await sheet.protect('', {
      selectLockedCells: true, selectUnlockedCells: true,
      formatCells: false, formatColumns: false, formatRows: false,
      insertColumns: false, insertRows: false, insertHyperlinks: false,
      deleteColumns: false, deleteRows: false, sort: false, autoFilter: false, pivotTables: false
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
