import { NextResponse } from 'next/server'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getCurrentUser } from '@/lib/auth'

type PdfRow = {
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

type PdfSummary = {
  driverName: string
  totalNet: number
  night25: number
  night40: number
  sunday50: number
  holiday125: number
  grossWage?: number | null
}

// Immer dabei: Fahrer, Datum, Von, Bis. Alles danach ist über die
// Spalten-Auswahl im Formular steuerbar.
const BASE_COLUMNS = [
  { label: 'Fahrer', width: 110 },
  { label: 'Datum', width: 90 },
  { label: 'Von', width: 26 },
  { label: 'Bis', width: 26 }
]

const OPTIONAL_COLUMN_DEFS: Record<string, { label: string; width: number; value: (r: PdfRow) => string }> = {
  pause: { label: 'Pause', width: 34, value: (r) => (r.isFree ? '' : `${r.breakMinutes} min`) },
  weg: { label: 'Weg', width: 32, value: (r) => (r.isFree ? '' : `${r.commuteMinutes} min`) },
  netto: { label: 'Netto', width: 30, value: (r) => (r.isFree ? '' : `${r.netHours.toFixed(2)} h`) },
  gesamt: { label: 'Gesamt', width: 32, value: (r) => (r.isFree ? '' : `${r.totalHours.toFixed(2)} h`) },
  nacht25: { label: 'Nacht 25%', width: 36, value: (r) => (r.isFree || r.night25 <= 0.005 ? '' : `${r.night25.toFixed(2)} h`) },
  nacht40: { label: 'Nacht 40%', width: 36, value: (r) => (r.isFree || r.night40 <= 0.005 ? '' : `${r.night40.toFixed(2)} h`) },
  sonntag50: { label: 'Sonntag 50%', width: 40, value: (r) => (r.isFree || r.sunday50 <= 0.005 ? '' : `${r.sunday50.toFixed(2)} h`) },
  feiertag125: { label: 'Feiertag 125%', width: 44, value: (r) => (r.isFree || r.holiday125 <= 0.005 ? '' : `${r.holiday125.toFixed(2)} h`) },
  fahrzeug: { label: 'Fahrzeug', width: 38, value: (r) => (r.isFree ? '' : r.vehiclePlate) }
}

// pdf-lib's Standard-Schriftarten unterstützen nur WinAnsi-Zeichen - Bindestrich-
// Varianten (En-/Em-Dash) und ein paar andere Sonderzeichen können damit vereinzelt
// zum Absturz führen. Sicherheitshalber auf reine ASCII-kompatible Zeichen abbilden.
function sanitizeForPdf(value: string): string {
  return value
    .replace(/[\u2013\u2014]/g, '-') // En-/Em-Dash -> Bindestrich
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x00-\xFF]/g, '?') // alles außerhalb Latin-1 (z. B. Emojis) ersetzen
}

export async function POST(request: Request) {
  try {
    // Eigene, für API-Routen geeignete Auth-Prüfung (requireCompanyUser()
    // ist für Server Components gedacht und nutzt redirect(), was in einer
    // Route Handler-Umgebung nicht sauber funktioniert). getCurrentUser()
    // ist bereits korrekt gegen die RLS-Falle abgesichert (siehe dortiger
    // Kommentar) - liefert null, wenn kein gültiger Firmenzugriff besteht.
    const currentUser = await getCurrentUser()
    if (!currentUser || !currentUser.companyId) {
      return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })
    }

    const { title, rows, summaries, monthLabel, columns, vehiclePlate }: { title: string; rows: PdfRow[]; summaries?: PdfSummary[]; monthLabel?: string; columns?: string[]; vehiclePlate?: string } = await request.json()

    const activeOptionalColumns = (columns ?? ['pause', 'gesamt'])
      .filter((key) => OPTIONAL_COLUMN_DEFS[key])
      .map((key) => ({ key, ...OPTIONAL_COLUMN_DEFS[key] }))
    const ALL_COLUMNS = [...BASE_COLUMNS, ...activeOptionalColumns]

    const pdfDoc = await PDFDocument.create()
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    const pageWidth = 595 // A4 hoch (Portrait) in Punkt
    const pageHeight = 842
    const marginX = 30
    const marginTop = 40
    const rowHeight = 16
    const headerHeight = 20

    let page = pdfDoc.addPage([pageWidth, pageHeight])
    let cursorY = pageHeight - marginTop

    function drawHeader() {
      page.drawText(sanitizeForPdf(title), { x: marginX, y: cursorY, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.1) })
      if (monthLabel) {
        const label = sanitizeForPdf(monthLabel)
        const textWidth = fontBold.widthOfTextAtSize(label, 13)
        page.drawText(label, { x: pageWidth - marginX - textWidth, y: cursorY, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.1) })
      }
      if (vehiclePlate) {
        const label = `[${sanitizeForPdf(vehiclePlate)}]`
        const textWidth = font.widthOfTextAtSize(label, 10)
        page.drawText(label, { x: pageWidth - marginX - textWidth, y: cursorY - 15, size: 10, font, color: rgb(0.4, 0.4, 0.4) })
      }
      cursorY -= 28

      let x = marginX
      ALL_COLUMNS.forEach((col) => {
        page.drawText(col.label, { x, y: cursorY, size: 8, font: fontBold, color: rgb(0.35, 0.35, 0.35) })
        x += col.width
      })
      cursorY -= headerHeight
      page.drawLine({
        start: { x: marginX, y: cursorY + 6 }, end: { x: pageWidth - marginX, y: cursorY + 6 },
        thickness: 0.5, color: rgb(0.7, 0.7, 0.7)
      })
    }

    drawHeader()

    rows.forEach((r) => {
      if (cursorY < 40) {
        page = pdfDoc.addPage([pageWidth, pageHeight])
        cursorY = pageHeight - marginTop
        drawHeader()
      }

      const values = r.isFree
        ? [r.driverName, r.date, '', '', ...activeOptionalColumns.map(() => '')]
        : [r.driverName, r.date, r.start, r.end, ...activeOptionalColumns.map((c) => c.value(r))]
      const cleanValues = values.map(sanitizeForPdf)
      const textColor = r.isFree ? rgb(0.55, 0.55, 0.55) : rgb(0.1, 0.1, 0.1)

      let x = marginX
      cleanValues.forEach((val, i) => {
        page.drawText(val, { x, y: cursorY, size: 8, font, color: textColor })
        x += ALL_COLUMNS[i].width
      })
      cursorY -= rowHeight
    })

    // Zuschlags-Zusammenfassung je Fahrer (Nachtzuschlag 25/40 %,
    // Sonntagszuschlag 50 %) auf einer eigenen Seite ans Ende anhängen,
    // damit sie nicht nur am Bildschirm, sondern auch im heruntergeladenen
    // Dokument sichtbar ist.
    if (summaries && summaries.length > 0) {
      const summaryPage = pdfDoc.addPage([pageWidth, pageHeight])
      let sy = pageHeight - marginTop
      summaryPage.drawText('Monatszusammenfassung', { x: marginX, y: sy, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.1) })
      sy -= 30

      summaries.forEach((s) => {
        if (sy < 100) return // Sicherheitsgrenze, falls sehr viele Fahrer
        summaryPage.drawText(sanitizeForPdf(s.driverName), { x: marginX, y: sy, size: 11, font: fontBold, color: rgb(0.1, 0.1, 0.1) })
        sy -= 18
        const lines = [
          `Gesamt: ${s.totalNet.toFixed(2)} h`,
          `Nachtzuschlag 25 %: ${s.night25.toFixed(2)} h`,
          `Nachtzuschlag 40 % steuerfrei: ${s.night40.toFixed(2)} h`,
          `Sonntagszuschlag 50 %: ${s.sunday50.toFixed(2)} h`,
          `Feiertagszuschlag 125 %: ${s.holiday125.toFixed(2)} h`,
          `Bruttolohn (geschätzt): ${s.grossWage != null ? s.grossWage.toFixed(2) + ' EUR' : '- kein Stundenlohn hinterlegt -'}`
        ]
        lines.forEach((line) => {
          summaryPage.drawText(line, { x: marginX + 10, y: sy, size: 9, font, color: rgb(0.2, 0.2, 0.2) })
          sy -= 14
        })
        sy -= 10
      })
    }

    const pdfBytes = await pdfDoc.save()

    return new NextResponse(Buffer.from(pdfBytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="dienstplan.pdf"`
      }
    })
  } catch (err) {
    // Klare JSON-Fehlermeldung statt einer kryptischen HTML-Fehlerseite,
    // damit sich Probleme beim nächsten Mal sofort erkennen lassen.
    console.error('PDF-Erzeugung fehlgeschlagen:', err)
    return NextResponse.json(
      { error: 'PDF-Erzeugung fehlgeschlagen.', details: (err as Error).message },
      { status: 500 }
    )
  }
}
