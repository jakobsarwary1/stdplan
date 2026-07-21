import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { getCurrentUser } from '@/lib/auth'

type XlsxRow = {
  driverName: string
  date: string // bereits formatiert, z. B. "Mo. 01.06.26"
  start: string
  end: string
  breakLabel: string
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
  night25Amount?: number | null
  night40Amount?: number | null
  sunday50Amount?: number | null
  holiday125Amount?: number | null
}

// Immer dabei: Fahrer, Datum, Von, Bis. Alles danach ist über die
// Spalten-Auswahl im Formular steuerbar - konsistent mit dem PDF-Export.
const BASE_COLUMNS = [
  { key: 'driverName', label: 'Fahrer', width: 22 },
  { key: 'date', label: 'Datum', width: 18 },
  { key: 'start', label: 'Von', width: 8 },
  { key: 'end', label: 'Bis', width: 8 }
]

const OPTIONAL_COLUMN_DEFS: Record<string, { label: string; width: number; value: (r: XlsxRow) => string | number }> = {
  pause: { label: 'Pause', width: 10, value: (r) => (r.isFree ? '' : `${r.breakMinutes} min`) },
  weg: { label: 'Weg', width: 10, value: (r) => (r.isFree ? '' : `${r.commuteMinutes} min`) },
  netto: { label: 'Netto', width: 10, value: (r) => (r.isFree ? '' : r.netHours) },
  gesamt: { label: 'Gesamt', width: 10, value: (r) => (r.isFree ? '' : r.totalHours) },
  nacht25: { label: 'Nacht 25%', width: 12, value: (r) => (r.isFree || r.night25 <= 0.005 ? '' : r.night25) },
  nacht40: { label: 'Nacht 40%', width: 12, value: (r) => (r.isFree || r.night40 <= 0.005 ? '' : r.night40) },
  sonntag50: { label: 'Sonntag 50%', width: 12, value: (r) => (r.isFree || r.sunday50 <= 0.005 ? '' : r.sunday50) },
  feiertag125: { label: 'Feiertag 125%', width: 13, value: (r) => (r.isFree || r.holiday125 <= 0.005 ? '' : r.holiday125) },
  fahrzeug: { label: 'Fahrzeug', width: 12, value: (r) => (r.isFree ? '' : r.vehiclePlate) }
}

export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser || !currentUser.companyId) {
      return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })
    }

    const { title, rows, summaries, monthLabel, columns, vehiclePlate }: { title: string; rows: XlsxRow[]; summaries?: XlsxSummary[]; monthLabel?: string; columns?: string[]; vehiclePlate?: string } = await request.json()

    const activeOptionalColumns = (columns ?? ['pause', 'gesamt'])
      .filter((key) => OPTIONAL_COLUMN_DEFS[key])
      .map((key) => ({ key, ...OPTIONAL_COLUMN_DEFS[key] }))
    const allColumns = [...BASE_COLUMNS, ...activeOptionalColumns]

    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'FleetOS'
    workbook.created = new Date()

    // ---- Blatt 1: Dienstplan ----
    const sheet = workbook.addWorksheet('Dienstplan')
    sheet.columns = allColumns.map((c) => ({ width: c.width }))

    // Kopfzeile mit Titel + Monat/Fahrzeug
    const titleParts = [title, monthLabel, vehiclePlate ? `[${vehiclePlate}]` : ''].filter(Boolean)
    const titleRow = sheet.addRow([titleParts.join('  ·  ')])
    titleRow.font = { bold: true, size: 14 }
    sheet.mergeCells(1, 1, 1, allColumns.length)
    sheet.addRow([])

    const headerRow = sheet.addRow(allColumns.map((c) => c.label))
    headerRow.font = { bold: true }
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } } }
    })

    rows.forEach((r) => {
      const values = r.isFree
        ? [r.driverName, r.date, '', '', ...activeOptionalColumns.map(() => '')]
        : [r.driverName, r.date, r.start, r.end, ...activeOptionalColumns.map((c) => c.value(r))]
      const row = sheet.addRow(values)
      if (r.isFree) row.font = { color: { argb: 'FF999999' }, italic: true }
    })

    // ---- Blatt 2: Monatszusammenfassung ----
    if (summaries && summaries.length > 0) {
      const sumSheet = workbook.addWorksheet('Zusammenfassung')
      sumSheet.columns = [{ width: 32 }, { width: 16 }, { width: 16 }]

      const fmtEur = (v?: number | null) => (v != null ? `${v.toFixed(2)} EUR` : '–')
      const t = sumSheet.addRow(['Monatszusammenfassung'])
      t.font = { bold: true, size: 14 }
      sumSheet.addRow([])

      summaries.forEach((s) => {
        const nameRow = sumSheet.addRow([s.driverName])
        nameRow.font = { bold: true, size: 12 }
        sumSheet.addRow(['Gesamt (Netto)', `${s.totalNet.toFixed(2)} h`])
        sumSheet.addRow(['Nachtzuschlag 25 %', `${s.night25.toFixed(2)} h`, fmtEur(s.night25Amount)])
        sumSheet.addRow(['Nachtzuschlag 40 % steuerfrei', `${s.night40.toFixed(2)} h`, fmtEur(s.night40Amount)])
        sumSheet.addRow(['Sonntagszuschlag 50 %', `${s.sunday50.toFixed(2)} h`, fmtEur(s.sunday50Amount)])
        sumSheet.addRow(['Feiertagszuschlag 125 %', `${s.holiday125.toFixed(2)} h`, fmtEur(s.holiday125Amount)])
        sumSheet.addRow(['Bruttolohn (geschätzt)', fmtEur(s.grossWage)])
        sumSheet.addRow([])
      })
    }

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
