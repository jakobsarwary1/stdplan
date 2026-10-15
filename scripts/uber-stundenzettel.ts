// Stundenplan aus Uber-trip_activity-CSVs.
//   npx tsx scripts/uber-stundenzettel.ts <datei.csv> [...] [--out datei.xlsx]
import fs from 'node:fs'
import path from 'node:path'
import { buildPlansFromCsv, monthLabelDE, timesheetHours } from '../src/lib/planning/uberPlan'
import { workbookForPlans } from '../src/lib/planning/uberExcel'

const args = process.argv.slice(2)
let outPath: string | null = null
const csvPaths: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i]
  else csvPaths.push(args[i])
}
if (!csvPaths.length) {
  console.error('Nutzung: npx tsx scripts/uber-stundenzettel.ts <trip_activity.csv> [...] [--out DATEI.xlsx]')
  process.exit(1)
}

async function main() {
  const texts = csvPaths.map((p) => fs.readFileSync(p, 'utf8'))
  const plans = buildPlansFromCsv(texts)
  if (!plans.length) {
    console.error('Keine abgeschlossenen Fahrten gefunden.')
    process.exit(1)
  }

  const month = plans[0].month ? monthLabelDE(plans[0].month).replace(/\s+/g, '_') : 'Monat'
  const out = outPath || path.join(path.dirname(csvPaths[0]), `Stundenzettel_${month}.xlsx`)
  const wb = await workbookForPlans(plans)
  await wb.xlsx.writeFile(out)

  for (const p of plans) {
    const stunden = timesheetHours(p).paidHours
    console.log(`${p.name.padEnd(28)} ${stunden.toFixed(2)} h im Stundenzettel · ${p.workDays} Arbeitstage · ${p.freeDays} frei · ${p.ruheTage} Ruhetag`)
  }
  console.log(`\n→ ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
