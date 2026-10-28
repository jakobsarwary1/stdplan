import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { pdfLayoutLines } from '@/lib/planning/pdfText'
import { parseLohnabrechnung, findeFahrer, type LohnParse } from '@/lib/planning/lohnabrechnung'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_PDFS = 80
const MAX_PDF_BYTES = 4_000_000 // 4 MB je PDF (Lohn-PDFs sind ~10 KB)

type Eingabe = { filename?: string; dataBase64?: string }

/** Namensbestandteile aus dem Dateinamen (Fallback, wenn der Name im PDF fehlt). */
function nameAusDateiname(filename: string): string {
  const basis = filename.replace(/\.[a-z0-9]+$/i, '')
  return basis
    .replace(/[_-]+/g, ' ')
    .replace(/\bLohnabrechnung\b|\bLohn\b|\bAbrechnung\b/gi, ' ')
    .replace(/\b(Januar|Februar|M[äa]rz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/gi, ' ')
    .replace(/\b\d+\b/g, ' ') // Jahr, laufende Nummer
    .replace(/\s+/g, ' ')
    .trim()
}

type Ergebnis = LohnParse & { filename: string; fahrer: string | null }

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user || !user.companyId) return NextResponse.json({ error: 'Kein Firmenzugriff.' }, { status: 403 })

  let body: { pdfs?: Eingabe[]; driverNames?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Die Anfrage ließ sich nicht lesen.' }, { status: 400 })
  }
  const pdfs = Array.isArray(body.pdfs) ? body.pdfs : []
  const driverNames = Array.isArray(body.driverNames) ? body.driverNames.filter((n) => typeof n === 'string') : []
  if (pdfs.length === 0) return NextResponse.json({ error: 'Keine Lohnabrechnung übergeben.' }, { status: 400 })
  if (pdfs.length > MAX_PDFS) return NextResponse.json({ error: `Zu viele Dateien (max. ${MAX_PDFS}).` }, { status: 400 })

  const ergebnisse: Ergebnis[] = []
  for (const p of pdfs) {
    const filename = (p?.filename || 'Lohnabrechnung.pdf').slice(0, 200)
    try {
      const buf = Buffer.from(String(p?.dataBase64 || ''), 'base64')
      if (buf.length === 0 || buf.length > MAX_PDF_BYTES) {
        ergebnisse.push({ ...leer(), filename, fahrer: null, warnungen: ['Datei leer oder zu groß.'] })
        continue
      }
      // Nur echte PDFs (Magic Bytes "%PDF").
      if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
        ergebnisse.push({ ...leer(), filename, fahrer: null, warnungen: ['Keine PDF-Datei.'] })
        continue
      }
      const lines = await pdfLayoutLines(new Uint8Array(buf))
      const parsed = parseLohnabrechnung(lines)
      // Zuordnung: erst der im PDF stehende Name, sonst der Dateiname.
      let fahrer = findeFahrer(parsed.name, driverNames)
      if (!fahrer) fahrer = findeFahrer(nameAusDateiname(filename), driverNames)
      const warnungen = [...parsed.warnungen]
      if (!fahrer && parsed.gesamt > 0) {
        warnungen.push('Nicht in der CSV gefahren – wird als eigener Stundenzettel angelegt.')
      } else if (!fahrer) {
        warnungen.push('Kein passender Fahrer in der CSV und keine Grundstunden – übersprungen.')
      }
      ergebnisse.push({ ...parsed, filename, fahrer, warnungen })
    } catch {
      ergebnisse.push({ ...leer(), filename, fahrer: null, warnungen: ['PDF ließ sich nicht lesen.'] })
    }
  }

  // Zielwerte je Fahrer mit Grundstunden > 0. Zugeordnete Fahrer unter ihrem
  // CSV-Namen; nicht zugeordnete (Lohn ohne CSV-Fahrten) unter ihrem Abrechnungs-
  // namen – der Exakt-Planer legt dafür einen eigenen Stundenzettel an.
  const ziele: Record<string, { gesamt: number; sonntag: number; nacht25: number; nacht40: number; feiertag: number }> = {}
  for (const e of ergebnisse) {
    if (e.gesamt <= 0) continue
    const key = e.fahrer || e.name || nameAusDateiname(e.filename)
    if (!key) continue
    ziele[key] = { gesamt: e.gesamt, sonntag: e.sonntag, nacht25: e.nacht25, nacht40: e.nacht40, feiertag: e.feiertag }
  }

  return NextResponse.json({
    ziele,
    ergebnisse: ergebnisse.map((e) => ({
      filename: e.filename, name: e.name,
      fahrer: e.fahrer || (e.gesamt > 0 ? (e.name || nameAusDateiname(e.filename)) : null),
      nichtInCsv: !e.fahrer && e.gesamt > 0,
      month: e.month,
      gesamt: e.gesamt, sonntag: e.sonntag, nacht25: e.nacht25, nacht40: e.nacht40,
      feiertag: e.feiertag, krank: e.krank, urlaub: e.urlaub, warnungen: e.warnungen,
    })),
  })
}

function leer(): LohnParse {
  return { name: '', month: null, gesamt: 0, sonntag: 0, nacht25: 0, nacht40: 0, feiertag: 0, krank: 0, urlaub: 0, stundenlohn: null, warnungen: [] }
}
