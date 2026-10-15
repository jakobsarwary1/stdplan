// Stundenzettel aus Uber-trip_activity-CSV(s) – ALLE Fahrer in EINER CSV-Datei,
// jeder Fahrer als eigene, durch Leerzeilen getrennte Tabelle.
//
//   npx tsx scripts/uber-stundenzettel-csv.ts <trip_activity.csv> [...] [--out DATEI.csv]
import fs from 'node:fs'
import path from 'node:path'
import { buildPlansFromCsv } from '../src/lib/planning/uberPlan'
import { buildCsvForPlans } from '../src/lib/planning/uberCsv'

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

const texts = csvPaths.map((p) => fs.readFileSync(p, 'utf8'))
const plans = buildPlansFromCsv(texts)
if (!plans.length) {
  console.error('Keine abgeschlossenen Fahrten gefunden.')
  process.exit(1)
}

const { csv, monthLabel } = buildCsvForPlans(plans)
const out = outPath || path.join(path.dirname(csvPaths[0]), `Stundenzettel_${monthLabel.replace(/\s+/g, '_')}_alle-Fahrer.csv`)
fs.writeFileSync(out, csv, 'utf8')

for (const p of [...plans].sort((a, b) => b.paidH - a.paidH)) {
  console.log(`${p.name.padEnd(28)} ${p.paidH.toFixed(2)} h · ${p.workDays} AT · ${p.freeDays} frei · ${p.ruheTage} Ruhetag`)
}
console.log(`\n→ ${out}`)
