// Browser-Speicher der Monats-Stunden je Fahrer (für die Jahres-Stundenübersicht).
// v1 bewusst im localStorage (kein DB-Eingriff): Beim Erstellen eines
// Stundenzettels werden die Summen gespeichert; die Übersicht liest sie.
export type MonatEintrag = {
  month: string // "YYYY-MM"
  name: string
  worked: number // gefahren netto (bezahlte Arbeitszeit ohne Krank)
  sonntag: number
  nacht25: number
  nacht40: number
  feiertag: number
  krank: number
  sundaysWorked: number // Anzahl gearbeiteter Sonntags-TAGE (für § 11)
  soll?: { gesamt: number; sonntag: number; nacht25: number; nacht40: number; feiertag: number } | null
}

const KEY = 'stdplan.monate'

export function ladeMonate(): MonatEintrag[] {
  try { const r = localStorage.getItem(KEY); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a as MonatEintrag[] : [] } catch { return [] }
}
export function speichereMonate(arr: MonatEintrag[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(arr)) } catch { /* ignore */ }
}
/** Fügt Einträge ein/überschreibt sie je (Monat + Fahrer). */
export function upsertMonate(eintraege: MonatEintrag[]): void {
  const map = new Map(ladeMonate().map((e) => [`${e.month}|${e.name.toLowerCase()}`, e]))
  for (const e of eintraege) map.set(`${e.month}|${e.name.toLowerCase()}`, e)
  speichereMonate([...map.values()])
}
/** Löscht einen Eintrag (Monat + Fahrer). */
export function loescheMonat(month: string, name: string): void {
  speichereMonate(ladeMonate().filter((e) => !(e.month === month && e.name.toLowerCase() === name.toLowerCase())))
}

/** Anzahl Sonntage in einem Kalenderjahr. */
export function sonntageImJahr(year: number): number {
  let c = 0; const d = new Date(Date.UTC(year, 0, 1))
  while (d.getUTCFullYear() === year) { if (d.getUTCDay() === 0) c++; d.setUTCDate(d.getUTCDate() + 1) }
  return c
}
/** § 11 ArbZG: mindestens 15 Sonntage/Jahr müssen frei bleiben. */
export const MIN_FREIE_SONNTAGE = 15
/** Maximal zulässige Arbeits-Sonntage im Jahr. */
export function maxArbeitsSonntage(year: number): number {
  return Math.max(0, sonntageImJahr(year) - MIN_FREIE_SONNTAGE)
}
