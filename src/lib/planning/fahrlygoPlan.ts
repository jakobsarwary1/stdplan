// Monats-Stundenplan aus einer Fahrlygo-Fahrtliste (CSV-Export „rides-archive").
//
// Fahrlygo-CSV: Semikolon-getrennt, UTF-8-BOM. Spalten:
//   Datum;Fahrer;Kunde;Abholadresse;Zieladresse;Status;Zahlung;Preis (EUR);Rate (EUR/km)
//
// Anders als bei Uber steht je Fahrt nur EIN Zeitpunkt (Datum) – keine Endzeit.
// Die Schicht eines Tages ergibt sich deshalb aus der ERSTEN bis zur LETZTEN
// Fahrt des Fahrers an dem Tag. Da keine Fahrtdauer vorliegt, bekommt jede Fahrt
// eine kurze Nenn-Dauer (FAHRT_MIN), damit die letzte Fahrt die Schicht nicht auf
// 0 Minuten zusammenfallen lässt. Die gelben Von/Bis-Felder im Stundenzettel
// bleiben manuell korrigierbar – die Rohdaten geben nur den Rahmen vor.
//
// Ab da identisch zu Uber: dieselbe planDriver()-Logik (Pausen, Ruhezeiten,
// Ruhetag je Woche) und dieselben Excel-/CSV-Ausgaben, inkl. roter Sonntage.

import { planDriverByGaps, type DriverPlan, type Trip } from './uberPlan'

/** Nenn-Dauer je Fahrt in Minuten – nur fürs Ende der letzten Fahrt relevant. */
export const FAHRT_MIN = 15

/**
 * Ab welcher Lücke (Stunden) zwischen zwei Fahrten eine NEUE Schicht beginnt.
 * Kleinere Lücken gelten als Pause innerhalb derselben Schicht. So wird ein Tag
 * mit Früh- UND Spätschicht korrekt in zwei Schichten geteilt (erste→letzte
 * Fahrt je Schicht), statt die mittleren Fahrten zu verwerfen.
 */
export const SCHICHT_GAP_H = 3

/** CSV mit Semikolon-Trenner lesen (Fahrlygo). Quotes/Zeilenumbrüche beachtet. */
function parseCsvSemicolon(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let q = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++ } else q = false
      } else cur += c
    } else if (c === '"') q = true
    else if (c === ';') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row) }
  return rows
}

function col(header: string[], ...names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase())
    if (i >= 0) return i
  }
  return -1
}

/** "31.01.2026 03:49" (Wanduhr) → ms, zeitzonenunabhängig. Sonst null. */
export function parseFahrlygoDatum(value: string): number | null {
  const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value || '')
  if (!m) return null
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0))
}

/** Erkennt eine Fahrlygo-CSV am Kopf (Datum + Fahrer, Semikolon). */
export function looksLikeFahrlygo(text: string): boolean {
  const first = (text.replace(/^﻿/, '').split(/\r?\n/)[0] || '').toLowerCase()
  return first.includes(';') && first.includes('datum') && first.includes('fahrer')
}

/** Fahrten je Fahrer aus einer oder mehreren Fahrlygo-CSVs. */
export function readTripsFromFahrlygoCsv(csvTexts: string[]): Map<string, Trip[]> {
  const drivers = new Map<string, Trip[]>()
  for (const text of csvTexts) {
    const rows = parseCsvSemicolon(text)
    if (!rows.length) continue
    const header = rows[0]
    const datumI = col(header, 'Datum')
    const fahrerI = col(header, 'Fahrer')
    const statusI = col(header, 'Status')
    if (datumI < 0 || fahrerI < 0) continue
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length <= Math.max(datumI, fahrerI)) continue
      const name = (r[fahrerI] || '').trim()
      if (!name) continue
      // Stornierte/abgebrochene Fahrten nicht als Arbeitszeit werten.
      const st = statusI >= 0 ? (r[statusI] || '').trim().toLowerCase() : ''
      if (/storn|cancel|abgebroch|abgelehnt|no.?show/.test(st)) continue
      const ts = parseFahrlygoDatum(r[datumI] || '')
      if (ts == null) continue
      const trip: Trip = { startMs: ts, endMs: ts + FAHRT_MIN * 60000 }
      const list = drivers.get(name)
      if (list) list.push(trip)
      else drivers.set(name, [trip])
    }
  }
  return drivers
}

/** Monats-Pläne je Fahrer aus Fahrlygo-CSVs – wie buildPlansFromCsv für Uber. */
export function buildPlansFromFahrlygoCsv(csvTexts: string[]): DriverPlan[] {
  const drivers = readTripsFromFahrlygoCsv(csvTexts)
  return [...drivers.entries()]
    .map(([name, trips]) => planDriverByGaps(name, trips, SCHICHT_GAP_H))
    .filter((p) => p.days.some((d) => d.kind === 'schicht'))
    .sort((a, b) => b.paidH - a.paidH || a.name.localeCompare(b.name, 'de'))
}
