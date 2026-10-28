// PDF-Text server-seitig (unpdf/pdf.js) – mit LAYOUT-Rekonstruktion.
//
// pdf.js liefert Textfragmente in Inhalts-Reihenfolge, NICHT in Lesereihenfolge.
// Für die Lohnabrechnung müssen Beschriftung und Zahl aber in derselben Zeile
// stehen (z. B. „1 Lohn 108,00 13,9000"). Darum gruppieren wir die Fragmente
// nach y-Position zu Zeilen und sortieren innerhalb der Zeile nach x – das
// rekonstruiert die Spalten wie ein „pdftotext -layout".
//
// Reines Server-Modul (kein externer Dienst, DSGVO-konform: alles lokal).

import { getDocumentProxy } from 'unpdf'

/** Rekonstruiert die sichtbaren Textzeilen eines PDFs (eine Zeile je y-Band). */
export async function pdfLayoutLines(data: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(data)
  const lines: string[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    const rows = new Map<number, { y: number; items: { x: number; str: string }[] }>()
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (!it || typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue
      const x = it.transform[4]
      const y = it.transform[5]
      const key = Math.round(y / 2) * 2 // 2-pt-Band gegen Mini-Versätze
      let r = rows.get(key)
      if (!r) { r = { y, items: [] }; rows.set(key, r) }
      r.items.push({ x, str: it.str })
    }
    const sorted = [...rows.values()].sort((a, b) => b.y - a.y) // oben → unten
    for (const r of sorted) {
      r.items.sort((a, b) => a.x - b.x)
      lines.push(r.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim())
    }
    lines.push('') // Seitentrenner
  }
  return lines
}
