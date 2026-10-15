// Stundenzettel aus Uber-trip_activity-CSV(s) – ALLE Fahrer in EINER CSV-Datei,
// jeder Fahrer als eigene, durch Leerzeilen getrennte Tabelle.
//
//   npx tsx scripts/uber-stundenzettel-csv.ts <trip_activity.csv> [...] [--out DATEI.csv]
//
// Deutsches CSV: Semikolon als Trenner, Komma als Dezimalzeichen, UTF-8 mit BOM
// (damit Excel Umlaute und Spalten direkt richtig anzeigt).
import fs from 'node:fs'
import path from 'node:path'
import { buildPlansFromCsv, dayRow, monthLabelDE, timesheetHours } from '../src/lib/planning/uberPlan'

const args = process.argv.slice(2)
let outPath: string | null = null
const csvPaths: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i]
  else csvPaths.push(args[i])
}
if (!csvPaths.length) {
  console.error('Nutzung: npx tsx scripts/uber-stundenzettel-csv.ts <trip_activity.csv> [...] [--out DATEI.csv]')
  process.exit(1)
}

/** Eine Zelle fürs deutsche CSV: Komma-Dezimal, Semikolon/Anführungszeichen maskiert. */
function cell(v: string | number | null): string {
  if (v == null) return ''
  let s = typeof v === 'number' ? v.toFixed(2).replace('.', ',') : String(v)
  if (/[";\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}
const row = (...cols: (string | number | null)[]) => cols.map(cell).join(';')

const texts = csvPaths.map((p) => fs.readFileSync(p, 'utf8'))
const plans = buildPlansFromCsv(texts)
if (!plans.length) {
  console.error('Keine abgeschlossenen Fahrten gefunden.')
  process.exit(1)
}

const monthYm = plans.find((p) => p.month)?.month ?? ''
const monatLabel = monthYm ? monthLabelDE(monthYm) : 'Monat'

const KOPF = ['Tag', 'Start', 'Ende', 'Pause (h)', 'Stunden', 'Hinweis']
const bloecke: string[] = []

// Sortierung: meiste Stunden zuerst (wie im Excel), stabil über den Namen.
const sortiert = [...plans].sort((a, b) => timesheetHours(b).paidHours - timesheetHours(a).paidHours || a.name.localeCompare(b.name))

for (const p of sortiert) {
  const stunden = timesheetHours(p).paidHours
  const zeilen: string[] = []
  zeilen.push(row(`${p.name} — Stundenzettel ${monatLabel}`))
  zeilen.push(KOPF.join(';'))
  for (const day of p.days) {
    const d = dayRow(day)
    zeilen.push(row(d.tag, d.start, d.ende, d.pause, d.stunden, d.hinweis))
  }
  zeilen.push(row('Summe', '', '', '', stunden, `${p.workDays} Arbeitstage · ${p.freeDays} frei · ${p.ruheTage} Ruhetag`))
  bloecke.push(zeilen.join('\r\n'))
}

// Blöcke durch eine Leerzeile trennen → in Excel klar getrennte Tabellen.
const inhalt = '﻿' + bloecke.join('\r\n\r\n') + '\r\n'
const out = outPath || path.join(path.dirname(csvPaths[0]), `Stundenzettel_${monatLabel.replace(/\s+/g, '_')}_alle-Fahrer.csv`)
fs.writeFileSync(out, inhalt, 'utf8')

for (const p of sortiert) {
  console.log(`${p.name.padEnd(28)} ${timesheetHours(p).paidHours.toFixed(2)} h · ${p.workDays} AT · ${p.freeDays} frei · ${p.ruheTage} Ruhetag`)
}
console.log(`\n→ ${out}`)
