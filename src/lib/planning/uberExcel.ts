import { buildStundenzettelWorkbook, type StundenzettelRow, type StundenzettelSummary } from './stundenzettelExcel'
import { computeWage } from './wage'
import { monthLabelDE, timesheetHours, timesheetLines, type DriverPlan } from './uberPlan'

/** Tageszeilen eines Fahrer-Plans für das Stundenzettel-Blatt. */
export function planToRows(plan: DriverPlan): StundenzettelRow[] {
  return timesheetLines(plan).map((line) => ({
    driverName: line.driverName,
    // Die Uber-/Fahrlygo-CSV enthält keine Personalnummer – nichts erfinden.
    employeeNumber: null,
    date: line.isoDate,
    isoDate: line.isoDate,
    startMin: line.startMin,
    endMin: line.endMin,
    breakOffsetMin: line.breakOffsetMin,
    breakMinutes: line.breakMinutes,
    commuteMinutes: 0,
    netHours: line.paidHours,
    paidHours: line.paidHours,
    totalHours: line.paidHours,
    vehiclePlate: '',
    night25: line.night25,
    night40: line.night40,
    sunday50: line.sunday50,
    holiday125: line.holiday125,
    isFree: line.isFree,
    freeLabel: line.freeLabel,
  }))
}

/** Monatszusammenfassung eines Fahrer-Plans (inkl. geschätztem Bruttolohn). */
export function planToSummary(plan: DriverPlan): StundenzettelSummary {
  const hours = timesheetHours(plan)
  // Kein Stundenlohn in der CSV – also keinen erfinden. Die Lohn-Zelle im Excel
  // bleibt leer und editierbar; sobald jemand den Satz einträgt, rechnen die
  // Formeln (Grundlohn + Zuschläge) automatisch.
  const wage = computeWage(hours, null)
  return {
    driverName: plan.name,
    paidHours: hours.workedHours, // „Bezahlt" = Arbeitszeit (Spanne minus Pause)
    sickHours: 0,
    night25: hours.night25,
    night40: hours.night40,
    sunday50: hours.sunday50,
    holiday125: hours.holiday125,
    hourlyRate: null,
    night25Amount: wage.night25Amount,
    night40Amount: wage.night40Amount,
    sunday50Amount: wage.sunday50Amount,
    holiday125Amount: wage.holiday125Amount,
    grossWage: wage.brutto,
    soll: plan.ziel,
  }
}

/** Uber-Plan im gleichen Blatt wie der bestehende Monats-Stundenzettel. */
export async function workbookForPlans(plans: DriverPlan[]) {
  const rows = plans.flatMap(planToRows)
  const summaries = plans.map(planToSummary)
  const month = plans[0]?.month ?? ''
  const holidayDates = [...new Set(plans.flatMap((p) => p.feiertage ?? []))].sort()
  return buildStundenzettelWorkbook({
    rows,
    summaries,
    title: 'Stundenzettel',
    companyName: 'FirmaFly',
    monthLabel: month ? monthLabelDE(month) : '',
    holidayDates,
  })
}
