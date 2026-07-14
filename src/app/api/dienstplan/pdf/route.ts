import { NextResponse } from 'next/server'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getCurrentUser } from '@/lib/auth'

type PdfRow = {
  driverName: string
  date: string // bereits formatiert, z. B. "Mo. 01.06.26"
  start: string
  end: string
  breakLabel: string
  netHours: number
  totalHours: number
  vehiclePlate: string
  night25: number
  night40: number
  sunday50: number
  isFree?: boolean
}

type PdfSummary = {
  driverName: string
  totalNet: number
  night25: number
  night40: number
  sunday50: number
  grossWage?: number | null
}

const COLUMNS = [
  { label: 'Fahrer', width: 90 },
  { label: 'Datum', width: 65 },
  { label: 'Von', width: 35 },
  { label: 'Bis', width: 35 },
  { label: 'Pause', width: 110 },
  { label: 'Netto', width: 45 },
  { label: 'Gesamt', width: 45 },
  { label: 'Fahrzeug', width: 55 }
]

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

    const { title, rows, summaries, monthLabel }: { title: string; rows: PdfRow[]; summaries?: PdfSummary[]; monthLabel?: string } = await request.json()

    const pdfDoc = await PDFDocument.create()
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    const pageWidth = 842 // A4 quer (Landscape) in Punkt
    const pageHeight = 595
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
      cursorY -= 22

      let x = marginX
      COLUMNS.forEach((col) => {
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
        ? [r.driverName, r.date, '', '', '', '', '', '']
        : [
            r.driverName, r.date, r.start, r.end, r.breakLabel,
            `${r.netHours.toFixed(2)} h`, `${r.totalHours.toFixed(2)} h`,
            r.vehiclePlate
          ]
      const cleanValues = values.map(sanitizeForPdf)
      const textColor = r.isFree ? rgb(0.55, 0.55, 0.55) : rgb(0.1, 0.1, 0.1)

      let x = marginX
      cleanValues.forEach((val, i) => {
        page.drawText(val, { x, y: cursorY, size: 8, font, color: textColor })
        x += COLUMNS[i].width
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
