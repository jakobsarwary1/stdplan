import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { getCurrentUser } from '@/lib/auth'

// Eine Monatstabelle für ALLE Fahrer -> Dienstplan-Excel.
// Grundlohn = Gesamt Std * Stundenlohn. Zuschläge stapeln on top:
// Sonntag +50 %, Nacht +25 % bzw. +40 % auf die jeweils eingetragenen Stunden.
// "Krank", "1 % Brutto" und "abmelden" sind reine Textvermerke.

type Row = {
  sn: number
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
}

const EUR = '#,##0.00 €'
const STD = '0.00'

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user || !user.companyId) {
      return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })
    }

    const { monthLabel, companyName, rows }:
      { monthLabel?: string; companyName?: string; rows: Row[] } = await request.json()

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'Keine Fahrerzeilen übergeben.' }, { status: 400 })
    }

    const wb = new ExcelJS.Workbook()
    wb.creator = companyName || 'stdplan'
    wb.created = new Date()

    const sheet = wb.addWorksheet('Dienstplan', {
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      },
    })

    const HEADERS: [string, number, 'text' | 'std' | 'eur'][] = [
      ['S/N', 5, 'text'],
      ['Name', 24, 'text'],
      ['Pers.-Nr.', 10, 'text'],
      ['€/Std', 8, 'eur'],
      ['Gesamt Std (bezahlt)', 14, 'std'],
      ['Sonntag 50%', 12, 'std'],
      ['Nacht 25%', 11, 'std'],
      ['Nacht 40%', 11, 'std'],
      ['Grundlohn', 12, 'eur'],
      ['Zuschlag So 50%', 14, 'eur'],
      ['Zuschlag Nacht 25%', 16, 'eur'],
      ['Zuschlag Nacht 40%', 16, 'eur'],
      ['Lohn gesamt', 13, 'eur'],
      ['Krank', 16, 'text'],
      ['1 % Brutto', 11, 'text'],
      ['abmelden', 22, 'text'],
    ]
    const nCols = HEADERS.length

    // Titel
    const titleParts = ['Dienstplan', companyName, monthLabel].filter(Boolean)
    const titleRow = sheet.addRow([titleParts.join('  ·  ')])
    titleRow.font = { bold: true, size: 14 }
    sheet.mergeCells(1, 1, 1, nCols)
    sheet.addRow([])

    // Kopfzeile
    const headerRow = sheet.addRow(HEADERS.map(([h]) => h))
    headerRow.font = { bold: true }
    headerRow.alignment = { horizontal: 'center', wrapText: true, vertical: 'middle' }
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } }
    })
    HEADERS.forEach(([, w], i) => { sheet.getColumn(i + 1).width = w })

    const sum = { total: 0, sunday: 0, night25: 0, night40: 0, grund: 0, zSo: 0, zN25: 0, zN40: 0, gesamt: 0 }

    for (const r of rows) {
      const rate = Number(r.rate) || 0
      const total = Number(r.total) || 0
      const sunday = Number(r.sunday) || 0
      const n25 = Number(r.night25) || 0
      const n40 = Number(r.night40) || 0
      const grund = total * rate
      const zSo = sunday * rate * 0.5
      const zN25 = n25 * rate * 0.25
      const zN40 = n40 * rate * 0.4
      const gesamt = grund + zSo + zN25 + zN40

      sum.total += total; sum.sunday += sunday; sum.night25 += n25; sum.night40 += n40
      sum.grund += grund; sum.zSo += zSo; sum.zN25 += zN25; sum.zN40 += zN40; sum.gesamt += gesamt

      const row = sheet.addRow([
        r.sn, r.name, r.employeeNumber ?? '', rate, total, sunday, n25, n40,
        grund, zSo, zN25, zN40, gesamt,
        r.krank ?? '', r.brutto ?? '', r.abmelden ?? '',
      ])
      HEADERS.forEach(([, , type], i) => {
        const cell = row.getCell(i + 1)
        if (type === 'eur') cell.numFmt = EUR
        else if (type === 'std') cell.numFmt = STD
      })
    }

    // Summenzeile
    const totalRow = sheet.addRow([
      '', 'Summe', '', '', sum.total, sum.sunday, sum.night25, sum.night40,
      sum.grund, sum.zSo, sum.zN25, sum.zN40, sum.gesamt, '', '', '',
    ])
    totalRow.font = { bold: true }
    totalRow.eachCell((cell, col) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FFBFBFBF' } } }
      const type = HEADERS[col - 1]?.[2]
      if (type === 'eur') cell.numFmt = EUR
      else if (type === 'std') cell.numFmt = STD
    })

    const buf = await wb.xlsx.writeBuffer()
    const safeMonth = (monthLabel || 'Monat').replace(/[^A-Za-z0-9ÄÖÜäöü ]/g, '').replace(/\s+/g, '_')
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Dienstplan_${safeMonth}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Dienstplan-Excel fehlgeschlagen:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
