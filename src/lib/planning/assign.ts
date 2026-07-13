import type { VehicleSlot } from './slots'

export type DriverInput = {
  id: string
  firstName: string
  lastName: string
  status: string // active | inactive | terminated
  qualifications: string[]
  unavailability: { start: Date; end: Date }[]
}

export type ExistingShiftInput = {
  driverId: string | null
  vehicleId: string
  date: string
  start: string // "HH:MM"
  end: string // "HH:MM"
  breakMinutes: number
}

export type AssignedSlot = VehicleSlot & {
  driverId: string | null
  conflict: boolean
  conflictReason?: string
  isSubstitute?: boolean
  primaryDriverName?: string
}

function partsToDate(dateStr: string, minutesSinceMidnight: number): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, 0, minutesSinceMidnight, 0, 0)
}

function slotInterval(slot: { date: string; startMin: number; endMin: number }) {
  const start = partsToDate(slot.date, slot.startMin)
  const end = partsToDate(slot.date, slot.endMin)
  return { start, end }
}

function existingShiftInterval(s: ExistingShiftInput) {
  const [sh, sm] = s.start.split(':').map(Number)
  const [eh, em] = s.end.split(':').map(Number)
  const [y, mo, d] = s.date.split('-').map(Number)
  const start = new Date(y, mo - 1, d, sh, sm, 0, 0)
  let end = new Date(y, mo - 1, d, eh, em, 0, 0)
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 24 * 3600 * 1000)
  return { start, end }
}

function isDriverUnavailable(driver: DriverInput, date: string): boolean {
  const [y, m, d] = date.split('-').map(Number)
  const day = new Date(y, m - 1, d)
  return driver.unavailability.some((u) => day.getTime() >= u.start.getTime() && day.getTime() <= u.end.getTime())
}

/**
 * Weist Schicht-Slots automatisch Fahrer zu. Reihenfolge streng NACH der
 * Startzeit-Berechnung (siehe Super-Prompt Abschnitt 5.7, Schritt 9: "erst
 * danach wird der passende Fahrer gesucht").
 *
 * - Einzelfahrer-Slots (singleDriverMode): ausschließlich der Stammfahrer,
 *   Vertretung nur bei Abwesenheit, sonst "unbesetzt" - niemals ein
 *   beliebiger anderer Fahrer.
 * - Normale Slots: Fairness (wenigste Stunden zuerst) + leichte Bevorzugung
 *   des Fahrers, der dasselbe Fahrzeug zuletzt gefahren hat (weniger
 *   unnötige Fahrerwechsel), unter Einhaltung von Qualifikation,
 *   Verfügbarkeit, Ruhezeiten und keiner Doppelbelegung.
 */
export function assignDriversToSlots(
  slots: VehicleSlot[],
  drivers: DriverInput[],
  existingShifts: ExistingShiftInput[],
  minRestHours: number
): AssignedSlot[] {
  const sorted = [...slots].sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date.localeCompare(b.date)))

  type State = { intervals: { start: Date; end: Date }[]; hours: number; lastVehicleByDate: Map<string, string> }
  const state = new Map<string, State>()
  drivers.forEach((d) => state.set(d.id, { intervals: [], hours: 0, lastVehicleByDate: new Map() }))

  existingShifts.forEach((s) => {
    if (!s.driverId || !state.has(s.driverId)) return
    const { start, end } = existingShiftInterval(s)
    const st = state.get(s.driverId)!
    st.intervals.push({ start, end })
    const netH = Math.max(0, (end.getTime() - start.getTime()) / 3600000 - s.breakMinutes / 60)
    st.hours += netH
    st.lastVehicleByDate.set(s.date, s.vehicleId)
  })

  function isEligible(driver: DriverInput, slot: VehicleSlot, start: Date, end: Date): boolean {
    if (driver.status !== 'active') return false
    if (slot.requiredQualification) {
      const quals = driver.qualifications.map((q) => q.toLowerCase())
      if (!quals.includes(slot.requiredQualification.toLowerCase())) return false
    }
    if (isDriverUnavailable(driver, slot.date)) return false
    const st = state.get(driver.id)!
    return !st.intervals.some((iv) => {
      if (start < iv.end && end > iv.start) return true
      if (iv.end <= start && (start.getTime() - iv.end.getTime()) / 3600000 < minRestHours) return true
      if (iv.start >= end && (iv.start.getTime() - end.getTime()) / 3600000 < minRestHours) return true
      return false
    })
  }

  function assign(driver: DriverInput, slot: VehicleSlot, start: Date, end: Date) {
    const st = state.get(driver.id)!
    st.intervals.push({ start, end })
    const netH = Math.max(0, (end.getTime() - start.getTime()) / 3600000 - slot.breakMinutes / 60)
    st.hours += netH
    st.lastVehicleByDate.set(slot.date, slot.vehicleId)
  }

  function previousDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number)
    const dt = new Date(y, m - 1, d - 1)
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  }

  function sortByPriority(candidates: DriverInput[], slot: VehicleSlot) {
    return [...candidates].sort((a, b) => {
      const aContinuity = state.get(a.id)!.lastVehicleByDate.get(previousDate(slot.date)) === slot.vehicleId ? 0 : 1
      const bContinuity = state.get(b.id)!.lastVehicleByDate.get(previousDate(slot.date)) === slot.vehicleId ? 0 : 1
      if (aContinuity !== bContinuity) return aContinuity - bContinuity
      return state.get(a.id)!.hours - state.get(b.id)!.hours
    })
  }

  const results: AssignedSlot[] = []

  sorted.forEach((slot) => {
    const { start, end } = slotInterval(slot)

    if (slot.singleDriverMode) {
      const primary = slot.primaryDriverId ? drivers.find((d) => d.id === slot.primaryDriverId) : undefined

      if (!primary) {
        results.push({ ...slot, driverId: null, conflict: true, conflictReason: 'Kein Stammfahrer für dieses Fahrzeug hinterlegt.' })
        return
      }
      if (isEligible(primary, slot, start, end)) {
        assign(primary, slot, start, end)
        results.push({ ...slot, driverId: primary.id, conflict: false })
        return
      }

      const substitutes = sortByPriority(drivers.filter((d) => d.id !== primary.id && isEligible(d, slot, start, end)), slot)
      const sub = substitutes[0]
      if (sub) {
        assign(sub, slot, start, end)
        results.push({
          ...slot, driverId: sub.id, conflict: false, isSubstitute: true,
          primaryDriverName: `${primary.firstName} ${primary.lastName}`
        })
      } else {
        results.push({
          ...slot, driverId: null, conflict: true,
          conflictReason: `Stammfahrer „${primary.firstName} ${primary.lastName}" nicht verfügbar, keine Vertretung gefunden – Schicht bleibt unbesetzt.`
        })
      }
      return
    }

    const eligible = sortByPriority(drivers.filter((d) => isEligible(d, slot, start, end)), slot)
    const chosen = eligible[0]
    if (chosen) {
      assign(chosen, slot, start, end)
      results.push({ ...slot, driverId: chosen.id, conflict: false })
    } else {
      results.push({ ...slot, driverId: null, conflict: true, conflictReason: 'Kein verfügbarer Fahrer gefunden (Qualifikation/Ruhezeit/Verfügbarkeit).' })
    }
  })

  return results
}
