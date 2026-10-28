// Lohnabrechnung (PDF der Brutto-Netto-Bezüge) auslesen.
//
// Aus den rekonstruierten Textzeilen (siehe pdfText.ts) werden je Abrechnung die
// Monatssummen gezogen, GENAU wie sie das Büro sonst von Hand abtippen würde:
//   • Gesamt   = Lohnart „Lohn" (bezahlte Menge, mehrere Teilmonats-Blöcke
//                werden summiert)
//   • Sonntag  = „Sonntagszuschlag (50%)"
//   • Nacht 25 = „Nachtzuschlag (25%)"
//   • Nacht 40 = „Nachtzuschlag (40%)"
//   • Feiertag = „Feiertagszuschlag (125%)"
//   • Krank    = „Lohnfortzahlung" (Entgeltfortzahlung, separat – kein Zuschlag)
//   • Urlaub   = „Urlaubsstunden" (separat)
// Die Menge steht immer unmittelbar vor dem Faktor (4 Nachkommastellen), z. B.
// „108,00 13,9000". Fehlt bei pauschal besteuerten Minijobs die Menge, wird sie
// aus Betrag ÷ Stundenlohn abgeleitet (mit Hinweis).
//
// Reines Modul (keine IO) – unit-testbar. Eingabe sind fertige Textzeilen.

export type LohnParse = {
  /** Name laut Abrechnung ("Nachname Vorname" oder "Vorname Nachname"). */
  name: string
  /** Monat als "YYYY-MM", falls erkannt. */
  month: string | null
  gesamt: number
  sonntag: number
  nacht25: number
  nacht40: number
  feiertag: number
  krank: number
  urlaub: number
  /** Erkannter Stundenlohn (Faktor der Lohn-Zeile), falls vorhanden. */
  stundenlohn: number | null
  warnungen: string[]
}

const MONATE: Record<string, number> = {
  januar: 1, februar: 2, 'märz': 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
}

/** Deutsche Zahl "1.501,20" / "108,00" → 1501.2 / 108. */
function zahl(s: string): number {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'))
}

/** Menge (2 Nachkommastellen) unmittelbar vor dem Faktor (4 Nachkommastellen). */
function mengeVorFaktor(line: string): number | null {
  const m = /(\d{1,4}(?:\.\d{3})*,\d{2})\s+(\d{1,3},\d{4})/.exec(line)
  return m ? zahl(m[1]) : null
}

/** Betrag in EUR am Zeilenende (für pauschal besteuerte Minijobs ohne Menge). */
function betragEuro(line: string): number | null {
  const m = /(\d{1,4}(?:\.\d{3})*,\d{2})\s*EUR\b/.exec(line)
  return m ? zahl(m[1]) : null
}

function erkenneMonat(lines: string[]): string | null {
  for (const l of lines) {
    const m = /\b(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})\b/i.exec(l)
    if (m) {
      const mm = MONATE[m[1].toLowerCase()]
      if (mm) return `${m[2]}-${String(mm).padStart(2, '0')}`
    }
  }
  return null
}

// Feld-Vokabular der rechten Spalte (SV/Steuer/Urlaub), das wie ein Name
// aussehen könnte, aber keiner ist.
const NAME_STOP = /urlaub|resturlaub|anspruch|monatlich|kumuliert|steuer|brutto|beitrag|solz|kasse|gesundheit|konfession|faktor|kinder|personengruppe|freibetrag|abteilung|eintritt|austritt|aktivrente|bereich|hinzurech|netto|bez[üu]ge|altersversorgung|auszahlung|nummer|vwl|lohnart|bezeichnung|gesamtbrutto|str\.|stra[ßs]e|weg|platz|allee|gasse/i

/** Sieht die Zeile wie ein Personenname aus (2–4 reine Buchstaben-Wörter)? */
function nameLike(s: string): boolean {
  const t = s.trim()
  if (!t || /\d/.test(t)) return false
  if (NAME_STOP.test(t)) return false
  const toks = t.split(/\s+/)
  if (toks.length < 2 || toks.length > 4) return false
  if (toks.every((x) => x.length <= 2)) return false // z. B. „KV RV AV PV"
  return toks.every((x) => /^[A-Za-zÄÖÜäöüßéèçñ][A-Za-zÄÖÜäöüßéèçñ.\-]*$/.test(x))
}

function erkenneName(lines: string[]): string {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(Herrn?|Frau)\b(.*)$/.exec(lines[i].trim())
    if (!m) continue
    // Name als Rest derselben Zeile oder in einer der nächsten Zeilen (die
    // rechte SV-Spalte kann dazwischenliegen – daher bis zu 8 Zeilen scannen).
    const rest = m[2].trim()
    if (nameLike(rest)) return rest.replace(/\s+/g, ' ')
    for (const cand of lines.slice(i + 1, i + 9)) {
      if (nameLike(cand)) return cand.trim().replace(/\s+/g, ' ')
    }
  }
  return ''
}

/**
 * Liest EINE Lohnabrechnung aus ihren Textzeilen. Mehrere „Lohn"-Zeilen
 * (Teilmonate) werden summiert; Zuschläge werden über ihre Beschriftung
 * erkannt (nicht über die Lohnart-Nummer, die variiert).
 */
export function parseLohnabrechnung(lines: string[]): LohnParse {
  const w: string[] = []
  let gesamt = 0, sonntag = 0, nacht25 = 0, nacht40 = 0, feiertag = 0, krank = 0, urlaub = 0
  let stundenlohn: number | null = null
  let lohnEuroOffen: number | null = null

  for (const line of lines) {
    // „Lohn" (Grundlohn) – aber NICHT „Lohnfortzahlung“.
    if (/^\s*\d+\s+Lohn(?=\s)(?!fortzahlung)/i.test(line)) {
      const menge = mengeVorFaktor(line)
      const faktor = /(\d{1,3},\d{4})/.exec(line)
      if (faktor && stundenlohn == null) stundenlohn = zahl(faktor[1])
      if (menge != null) gesamt += menge
      else { const e = betragEuro(line); if (e != null) lohnEuroOffen = (lohnEuroOffen ?? 0) + e }
      continue
    }
    if (/Lohnfortzahlung/i.test(line)) { const v = mengeVorFaktor(line); if (v != null) krank += v; continue }
    if (/Nachtzuschlag\s*\(?\s*25/i.test(line)) { const v = mengeVorFaktor(line); if (v != null) nacht25 += v; continue }
    if (/Nachtzuschlag\s*\(?\s*40/i.test(line)) { const v = mengeVorFaktor(line); if (v != null) nacht40 += v; continue }
    if (/Sonntagszuschlag/i.test(line)) { const v = mengeVorFaktor(line); if (v != null) sonntag += v; continue }
    if (/Feiertagszuschlag|Feiertag\s*\(?\s*125/i.test(line)) { const v = mengeVorFaktor(line); if (v != null) feiertag += v; continue }
    if (/Urlaubsstunden/i.test(line)) { const v = mengeVorFaktor(line); if (v != null) urlaub += v; continue }
  }

  // Minijob ohne gedruckte Menge: Stunden aus Betrag ÷ Stundenlohn ableiten.
  if (gesamt === 0 && lohnEuroOffen != null) {
    const satz = stundenlohn ?? 13.9
    gesamt = Math.round((lohnEuroOffen / satz) * 100) / 100
    w.push(`Grundstunden aus Betrag ÷ Stundenlohn abgeleitet (${lohnEuroOffen.toFixed(2)} € ÷ ${satz.toFixed(2)} €).`)
  }

  const r2 = (n: number) => Math.round(n * 100) / 100
  return {
    name: erkenneName(lines),
    month: erkenneMonat(lines),
    gesamt: r2(gesamt), sonntag: r2(sonntag), nacht25: r2(nacht25), nacht40: r2(nacht40),
    feiertag: r2(feiertag), krank: r2(krank), urlaub: r2(urlaub),
    stundenlohn,
    warnungen: w,
  }
}

/** Namensschlüssel: nur Format weg, Reihenfolge der Namensteile egal. */
export function nameKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ')
}

/**
 * Ordnet den Namen einer Abrechnung einem der vorhandenen Fahrernamen zu.
 * Erst exakte Mengen-Gleichheit der Namensteile, sonst Teilmengen-Treffer
 * (alle Teile des einen kommen im anderen vor). Nur ein EINDEUTIGER Treffer
 * zählt – bei Mehrdeutigkeit kein Treffer (lieber manuell).
 */
export function findeFahrer(name: string, fahrer: string[]): string | null {
  const key = nameKey(name)
  if (!key) return null
  const exakt = fahrer.filter((f) => nameKey(f) === key)
  if (exakt.length === 1) return exakt[0]
  if (exakt.length > 1) return null
  const teile = new Set(key.split(' '))
  const teil = fahrer.filter((f) => {
    const ft = new Set(nameKey(f).split(' '))
    const a = [...teile].every((t) => ft.has(t))
    const b = [...ft].every((t) => teile.has(t))
    return a || b
  })
  return teil.length === 1 ? teil[0] : null
}
