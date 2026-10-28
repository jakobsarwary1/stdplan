// Gesetzliche Feiertage in Deutschland je Bundesland.
//
// Für § 3b EStG (Feiertagszuschlag 125 %) zählt der gesetzliche Feiertag am Ort
// der Tätigkeitsstätte. Die Tätigkeitsstätte liegt im Bundesland aus den
// Firmen-Einstellungen (CompanySettings.bundesland, Default "NW").
//
// Reines Modul ohne IO – unit-testbar. Datumsformat durchgängig "YYYY-MM-DD".

export type Bundesland =
  | 'BW' | 'BY' | 'BE' | 'BB' | 'HB' | 'HH' | 'HE' | 'MV'
  | 'NI' | 'NW' | 'RP' | 'SL' | 'SN' | 'ST' | 'SH' | 'TH'

const pad2 = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m1: number, d: number) => `${y}-${pad2(m1)}-${pad2(d)}`

/** Ostersonntag (gregorianisch) nach der anonymen Gauß-/Meeus-Formel. */
function ostersonntag(year: number): { m: number; d: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const dd = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - dd - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const monat = Math.floor((h + l - 7 * m + 114) / 31) // 3 = März, 4 = April
  const tag = ((h + l - 7 * m + 114) % 31) + 1
  return { m: monat, d: tag }
}

/** Datum relativ zu Ostersonntag um `delta` Tage, als ISO. */
function ab_ostern(year: number, delta: number): string {
  const o = ostersonntag(year)
  const base = new Date(Date.UTC(year, o.m - 1, o.d))
  base.setUTCDate(base.getUTCDate() + delta)
  return base.toISOString().slice(0, 10)
}

// Bundesländer je beweglichem/festem Zusatzfeiertag.
const FRONLEICHNAM = new Set<Bundesland>(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'])
const ALLERHEILIGEN = new Set<Bundesland>(['BW', 'BY', 'NW', 'RP', 'SL'])
const HEILIGE_DREI_KOENIGE = new Set<Bundesland>(['BW', 'BY', 'ST'])
const MARIAE_HIMMELFAHRT = new Set<Bundesland>(['SL']) // (in BY nur teilweise – hier konservativ nur SL)
const REFORMATIONSTAG = new Set<Bundesland>(['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'])
const FRAUENTAG = new Set<Bundesland>(['BE', 'MV'])
const WELTKINDERTAG = new Set<Bundesland>(['TH'])

/** Mittwoch vor dem 23. November (Buß- und Bettag), nur Sachsen. */
function bussUndBettag(year: number): string {
  const d = new Date(Date.UTC(year, 10, 23)) // 23. Nov
  // zurück bis zum letzten Mittwoch (getUTCDay 3)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 4) % 7 || 7))
  return d.toISOString().slice(0, 10)
}

/**
 * Alle gesetzlichen Feiertage eines Jahres im angegebenen Bundesland als
 * Menge von ISO-Daten. Unbekanntes Bundesland → nur die bundesweiten.
 */
export function gesetzlicheFeiertage(year: number, bundesland: string = 'NW'): Set<string> {
  const bl = (bundesland || 'NW').toUpperCase() as Bundesland
  const f = new Set<string>()

  // Bundesweit (fest):
  f.add(iso(year, 1, 1)) // Neujahr
  f.add(iso(year, 5, 1)) // Tag der Arbeit
  f.add(iso(year, 10, 3)) // Tag der Deutschen Einheit
  f.add(iso(year, 12, 25)) // 1. Weihnachtstag
  f.add(iso(year, 12, 26)) // 2. Weihnachtstag
  // Bundesweit (beweglich, österlich):
  f.add(ab_ostern(year, -2)) // Karfreitag
  f.add(ab_ostern(year, 1)) // Ostermontag
  f.add(ab_ostern(year, 39)) // Christi Himmelfahrt
  f.add(ab_ostern(year, 50)) // Pfingstmontag

  // Länderspezifisch:
  if (HEILIGE_DREI_KOENIGE.has(bl)) f.add(iso(year, 1, 6))
  if (FRAUENTAG.has(bl)) f.add(iso(year, 3, 8))
  if (FRONLEICHNAM.has(bl)) f.add(ab_ostern(year, 60))
  if (MARIAE_HIMMELFAHRT.has(bl)) f.add(iso(year, 8, 15))
  if (WELTKINDERTAG.has(bl)) f.add(iso(year, 9, 20))
  if (REFORMATIONSTAG.has(bl)) f.add(iso(year, 10, 31))
  if (ALLERHEILIGEN.has(bl)) f.add(iso(year, 11, 1))
  if (bl === 'SN') f.add(bussUndBettag(year))

  return f
}

/** Feiertage, die in den Monat "YYYY-MM" fallen (für das angegebene Bundesland). */
export function feiertageImMonat(month: string, bundesland: string = 'NW'): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  if (!m) return []
  const praefix = `${m[1]}-${m[2]}-`
  return [...gesetzlicheFeiertage(Number(m[1]), bundesland)].filter((d) => d.startsWith(praefix)).sort()
}
