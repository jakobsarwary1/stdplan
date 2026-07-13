import { computeShiftTiming, timingToBreakBlocks, type ShiftFrame } from './timing'
import type { DemandProfileInput } from './demand'

export type TemplateShiftInput = ShiftFrame & {
  id: string
  name: string
  driverCount: number
  weekdays: number[]
  requiredQualification: string | null
}

export type VehicleSlot = {
  vehicleId: string
  vehiclePlate: string
  templateShiftId: string
  shiftName: string
  date: string // YYYY-MM-DD
  startMin: number // Minuten seit Mitternacht des `date`
  endMin: number // kann > 1440 sein (Übernacht-Schicht)
  breakMinutes: number
  breaks: { start: number; end: number }[]
  requiredQualification: string | null
  singleDriverMode: boolean
  primaryDriverId: string | null
}

export type SkippedShift = { templateShiftId: string; shiftName: string; date: string; reason: string }

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Erzeugt für ein Fahrzeug alle Schicht-Slots im Zeitraum [startDateStr,
 * endDateStr]. Eine ungültige Schichtdefinition (z. B. Netto-Arbeitszeit
 * fehlt) führt NICHT zu einer 0-Minuten-Schicht, sondern wird übersprungen
 * und in `skipped` mit Grund aufgeführt - der Disponent bekommt das klar
 * angezeigt, statt einen stillen Datenfehler zu produzieren.
 */
export function generateSlotsForVehicle(
  vehicle: { id: string; licensePlate: string; defaultDriverId: string | null },
  templateShifts: TemplateShiftInput[],
  singleDriverMode: boolean,
  startDateStr: string,
  endDateStr: string,
  demandProfiles: DemandProfileInput[],
  nightStart: string,
  nightEnd: string
): { slots: VehicleSlot[]; skipped: SkippedShift[] } {
  const slots: VehicleSlot[] = []
  const skipped: SkippedShift[] = []

  const [sy, sm, sd] = startDateStr.split('-').map(Number)
  const [ey, em, ed] = endDateStr.split('-').map(Number)
  const start = new Date(sy, sm - 1, sd)
  const end = new Date(ey, em - 1, ed)

  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
    const dateStr = toDateStr(d)
    const weekday = d.getDay()

    templateShifts.forEach((ts) => {
      if (!ts.weekdays.includes(weekday)) return

      let timing
      try {
        timing = computeShiftTiming(ts, weekday, demandProfiles, nightStart, nightEnd)
      } catch (err) {
        skipped.push({ templateShiftId: ts.id, shiftName: ts.name, date: dateStr, reason: (err as Error).message })
        return
      }

      const spanMinutes = timing.endMin - timing.startMin
      const breaks = timingToBreakBlocks(spanMinutes, timing.breakMinutes)

      for (let i = 0; i < Math.max(1, ts.driverCount); i++) {
        slots.push({
          vehicleId: vehicle.id,
          vehiclePlate: vehicle.licensePlate,
          templateShiftId: ts.id,
          shiftName: ts.name,
          date: dateStr,
          startMin: timing.startMin,
          endMin: timing.endMin,
          breakMinutes: timing.breakMinutes,
          breaks,
          requiredQualification: ts.requiredQualification,
          singleDriverMode,
          primaryDriverId: singleDriverMode ? vehicle.defaultDriverId : null
        })
      }
    })
  }

  return { slots, skipped }
}

export function minToClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
