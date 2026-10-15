import { buildStundenzettelWorkbook, type StundenzettelRow, type StundenzettelSummary } from './stundenzettelExcel'
import { computeWage } from './wage'
import { monthLabelDE, timesheetHours, timesheetLines, type DriverPlan } from './uberPlan'

/** Uber-Plan im gleichen Blatt wie der bestehende Monats-Stundenzettel. */
export async function workbookForPlans(plans: DriverPlan[]) {
  const rows: StundenzettelRow[] = plans.flatMap((plan) => timesheetLines(plan).map((line) => ({
    driverName: line.driverName,
    employeeNumber: line.driverName === 'Mohammad Jakob Sarwary' ? '44' : null,
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
  })))
  const summaries: StundenzettelSummary[] = plans.map((plan) => {
    const hours = timesheetHours(plan)
    const wage = computeWage(hours, null)
    return {
      driverName: plan.name,
      paidHours: hours.paidHours,
      sickHours: 0,
      night25: hours.night25,
      night40: hours.night40,
      sunday50: hours.sunday50,
      holiday125: hours.holiday125,
      hourlyRate: 15,
      night25Amount: wage.night25Amount,
      night40Amount: wage.night40Amount,
      sunday50Amount: wage.sunday50Amount,
      holiday125Amount: wage.holiday125Amount,
      grossWage: wage.brutto,
    }
  })
  const month = plans[0]?.month ?? ''
  return buildStundenzettelWorkbook({
    rows,
    summaries,
    title: 'Stundenzettel',
    companyName: 'FirmaFly',
    monthLabel: month ? monthLabelDE(month) : '',
  })
}
