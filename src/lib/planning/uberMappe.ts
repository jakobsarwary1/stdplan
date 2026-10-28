// Eine Excel-Arbeitsmappe mit JE FAHRER EINEM EIGENEN TABELLENBLATT –
// jedes Blatt im vollen Dienstplan-Design (Von/Bis/Beginn/Ende/Pause/Weg,
// Netto, Ruhezeit, Zuschläge als Live-Formeln + Monatszusammenfassung +
// geschätztem Bruttolohn, gelbe editierbare Felder, Blattschutz).
import ExcelJS from 'exceljs'
import { addStundenzettelSheet } from './stundenzettelExcel'
import { planToRows, planToSummary } from './uberExcel'
import { monthLabelDE, type DriverPlan } from './uberPlan'

/** Blattname: eindeutig, ohne von Excel verbotene Zeichen, max. 31 Zeichen. */
function sheetName(name: string, used: Set<string>): string {
  const clean = name.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim() || 'Fahrer'
  let base = clean.slice(0, 31)
  let nm = base
  let k = 2
  while (used.has(nm.toLowerCase())) {
    const suffix = ` ${k++}`
    base = clean.slice(0, 31 - suffix.length)
    nm = base + suffix
  }
  used.add(nm.toLowerCase())
  return nm
}

/** Arbeitsmappe: ein Blatt pro Fahrer, jeweils im Standard-Dienstplan-Design. */
export async function buildWorkbookPerDriver(plans: DriverPlan[]): Promise<ExcelJS.Workbook> {
  const monthYm = plans.find((p) => p.month)?.month ?? ''
  const monat = monthYm ? monthLabelDE(monthYm) : ''

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'FleetOS'
  workbook.created = new Date()
  workbook.calcProperties.fullCalcOnLoad = true

  const used = new Set<string>()
  const sortiert = [...plans].sort((a, b) => b.paidH - a.paidH || a.name.localeCompare(b.name))

  for (const plan of sortiert) {
    await addStundenzettelSheet(workbook, {
      rows: planToRows(plan),
      summaries: [planToSummary(plan)],
      title: 'Dienstplan',
      companyName: plan.name,
      monthLabel: monat,
      sheetName: sheetName(plan.name, used),
      holidayDates: plan.feiertage ?? [],
    })
  }

  return workbook
}
