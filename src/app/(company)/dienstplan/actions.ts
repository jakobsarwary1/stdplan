'use server'

import { revalidatePath } from 'next/cache'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { generateSlotsForVehicle, type TemplateShiftInput } from '@/lib/planning/slots'
import { assignDriversToSlots, type AssignedSlot, type DriverInput, type ExistingShiftInput } from '@/lib/planning/assign'
import type { DemandProfileInput } from '@/lib/planning/demand'
import { generateHoursBasedSchedule, type HoursShift } from '@/lib/planning/hoursMode'

export type PlanningPreviewState = {
  slots: (AssignedSlot & { driverName: string | null })[]
  skipped: { templateShiftId: string; shiftName: string; date: string; reason: string }[]
  skippedVehicles: { vehiclePlate: string; reason: string }[]
  error: string | null
}

const EMPTY_STATE: PlanningPreviewState = { slots: [], skipped: [], skippedVehicles: [], error: null }

export async function previewAutoPlanning(
  _prev: PlanningPreviewState,
  formData: FormData
): Promise<PlanningPreviewState> {
  const user = await requireCompanyUser()

  const startDateStr = String(formData.get('startDate') ?? '')
  const endDateStr = String(formData.get('endDate') ?? '')
  const vehicleIds = formData.getAll('vehicleIds').map(String)

  if (!startDateStr || !endDateStr) return { ...EMPTY_STATE, error: 'Bitte Zeitraum wählen.' }
  if (vehicleIds.length === 0) return { ...EMPTY_STATE, error: 'Bitte mindestens ein Fahrzeug wählen.' }

  try {
    const result = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
      const [vehicles, drivers, demandProfilesRaw, settings, existingShiftsRaw] = await Promise.all([
        tx.vehicle.findMany({
          where: { id: { in: vehicleIds }, companyId: user.companyId },
          include: { shiftTemplate: { include: { shifts: true } } }
        }),
        tx.driver.findMany({
          where: { status: 'active', companyId: user.companyId },
          include: { unavailability: true }
        }),
        tx.demandProfile.findMany({ where: { companyId: user.companyId } }),
        tx.companySettings.findUnique({ where: { companyId: user.companyId! } }),
        tx.shift.findMany({
          where: { companyId: user.companyId, date: { gte: parseLocalDate(startDateStr), lte: parseLocalDate(endDateStr) } },
          select: { driverId: true, vehicleId: true, date: true, start: true, end: true, breakMinutes: true }
        })
      ])

      const demandProfiles: DemandProfileInput[] = demandProfilesRaw.map((p) => ({
        weekday: p.weekday, startTime: p.startTime, endTime: p.endTime, level: p.level as any
      }))
      const nightStart = settings?.nightStart ?? '22:00'
      const nightEnd = settings?.nightEnd ?? '06:00'
      const minRestHours = settings?.minRestHours ?? 11

      const driverInputs: DriverInput[] = drivers.map((d) => ({
        id: d.id,
        firstName: d.firstName,
        lastName: d.lastName,
        status: d.status,
        qualifications: d.qualifications,
        unavailability: d.unavailability.map((u) => ({ start: u.start, end: u.end }))
      }))

      const existingShifts: ExistingShiftInput[] = existingShiftsRaw.map((s) => ({
        driverId: s.driverId,
        vehicleId: s.vehicleId,
        date: s.date.toISOString().slice(0, 10),
        start: s.start,
        end: s.end,
        breakMinutes: s.breakMinutes
      }))

      let allSlots: ReturnType<typeof generateSlotsForVehicle>['slots'] = []
      let allSkipped: ReturnType<typeof generateSlotsForVehicle>['skipped'] = []
      const skippedVehicles: { vehiclePlate: string; reason: string }[] = []

      vehicles.forEach((v) => {
        if (!v.shiftTemplate) {
          skippedVehicles.push({ vehiclePlate: v.licensePlate, reason: 'Kein Schichtmodell zugewiesen.' })
          return
        }
        if (!v.shiftTemplate.active) {
          skippedVehicles.push({ vehiclePlate: v.licensePlate, reason: 'Schichtmodell ist inaktiv.' })
          return
        }
        if (v.shiftTemplate.mode === 'flexible') {
          skippedVehicles.push({ vehiclePlate: v.licensePlate, reason: 'Modell „Flexible Schicht" wird noch nicht unterstützt.' })
          return
        }
        if (v.shiftTemplate.singleDriverMode && !v.defaultDriverId) {
          skippedVehicles.push({ vehiclePlate: v.licensePlate, reason: 'Kein Stammfahrer hinterlegt (Pflichtfeld für dieses Schichtmodell).' })
          return
        }
        if (v.status !== 'active') {
          skippedVehicles.push({ vehiclePlate: v.licensePlate, reason: `Fahrzeugstatus „${v.status}".` })
          return
        }

        const templateShifts: TemplateShiftInput[] = v.shiftTemplate.shifts.map((s) => ({
          id: s.id,
          name: s.name,
          driverCount: s.driverCount,
          weekdays: s.weekdays,
          requiredQualification: s.requiredQualification,
          earliestStart: s.earliestStart,
          latestStart: s.latestStart,
          targetNetHours: s.targetNetHours,
          maxShiftHours: s.maxShiftHours,
          flexibleStart: s.flexibleStart,
          prioritizeDemand: s.prioritizeDemand,
          optimizeNightSurcharge: s.optimizeNightSurcharge,
          autoBreak: s.autoBreak
        }))

        const { slots, skipped } = generateSlotsForVehicle(
          { id: v.id, licensePlate: v.licensePlate, defaultDriverId: v.defaultDriverId },
          templateShifts,
          v.shiftTemplate.singleDriverMode,
          startDateStr,
          endDateStr,
          demandProfiles,
          nightStart,
          nightEnd
        )
        allSlots = allSlots.concat(slots)
        allSkipped = allSkipped.concat(skipped)
      })

      const assigned = assignDriversToSlots(allSlots, driverInputs, existingShifts, minRestHours)
      const driverNameById = new Map(driverInputs.map((d) => [d.id, `${d.firstName} ${d.lastName}`]))
      const assignedWithNames = assigned.map((s) => ({
        ...s,
        driverName: s.driverId ? driverNameById.get(s.driverId) ?? '—' : null
      }))

      return { slots: assignedWithNames, skipped: allSkipped, skippedVehicles }
    })

    return { ...result, error: null }
  } catch (err) {
    return { ...EMPTY_STATE, error: (err as Error).message }
  }
}

export async function applyAutoPlanning(formData: FormData) {
  const user = await requireCompanyUser()

  const raw = String(formData.get('slotsJson') ?? '[]')
  const slots: AssignedSlot[] = JSON.parse(raw)
  const toApply = slots.filter((s) => !s.conflict && s.driverId)

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
    const affectedByVehicle = new Map<string, Date[]>()
    toApply.forEach((s) => {
      const list = affectedByVehicle.get(s.vehicleId) ?? []
      list.push(parseLocalDate(s.date))
      affectedByVehicle.set(s.vehicleId, list)
    })
    for (const [vehicleId, dates] of affectedByVehicle) {
      await tx.shift.deleteMany({ where: { vehicleId, date: { in: Array.from(new Set(dates.map((d) => d.getTime()))).map((t) => new Date(t)) } } })
    }

    for (const s of toApply) {
      const shift = await tx.shift.create({
        data: {
          companyId: user.companyId,
          vehicleId: s.vehicleId,
          driverId: s.driverId,
          date: parseLocalDate(s.date),
          start: minToClock(s.startMin),
          end: minToClock(s.endMin),
          breakMinutes: s.breakMinutes,
          generated: true,
          isSubstitute: !!s.isSubstitute,
          shiftName: s.shiftName,
          fromShiftTemplateId: s.templateShiftId
        }
      })
      if (s.breaks.length > 0) {
        await tx.shiftBreak.createMany({
          data: s.breaks.map((b) => ({ shiftId: shift.id, start: b.start, end: b.end }))
        })
      }
    }
  })

  revalidatePath('/dienstplan')
}

// "YYYY-MM-DD" -> lokales Datum um Mitternacht - bewusst NICHT new Date(str),
// da das ISO-Datumsstrings als UTC-Mitternacht interpretiert und je nach
// Server-Zeitzone zu einer Verschiebung um einen Tag führen kann.
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function minToClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// ---------- Stundenbasierte Planung (z. B. Dokumentation für vergangene Monate) ----------

export type HoursPreviewRow = Partial<HoursShift> & {
  date: string
  driverId: string
  driverName: string
  vehiclePlate: string
  isFree: boolean
  isSunday: boolean
  isNightShift: boolean
  hourlyRate: number | null
  employeeNumber: string | null
  calculateExpenses: boolean
}

export type HoursPreviewState = {
  vehicleId: string
  shifts: HoursPreviewRow[]
  warnings: string[]
  error: string | null
}

const HOURS_EMPTY_STATE: HoursPreviewState = { vehicleId: '', shifts: [], warnings: [], error: null }

function isNightShiftRow(start: string, end: string, nightStart: string, nightEnd: string): boolean {
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  let s = toMin(start)
  let e = toMin(end)
  if (e <= s) e += 1440
  const nsMin = toMin(nightStart)
  let neMin = toMin(nightEnd)
  if (neMin <= nsMin) neMin += 1440
  const overlap = Math.min(e, nsMin + 1440) > Math.max(s, nsMin) ? Math.min(e, neMin) - Math.max(s, nsMin) : 0
  return overlap >= 120
}

function daysInMonthList(year: number, month1to12: number): string[] {
  const days: string[] = []
  const d = new Date(year, month1to12 - 1, 1)
  while (d.getMonth() === month1to12 - 1) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    d.setDate(d.getDate() + 1)
  }
  return days
}

export async function previewHoursPlanning(
  _prev: HoursPreviewState,
  formData: FormData
): Promise<HoursPreviewState> {
  const user = await requireCompanyUser()

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const year = parseInt(String(formData.get('year') ?? ''), 10)
  const month = parseInt(String(formData.get('month') ?? ''), 10) // 1-12 aus dem Formular

  if (!vehicleId || !year || !month) return { ...HOURS_EMPTY_STATE, error: 'Bitte Fahrzeug und Monat wählen.' }

  const targets: { driverId: string; totalHours: number; sundayHours: number; commuteMinutes: number; breakMinutesOverride: number | null; calculateExpenses: boolean; prioritizeDemand: boolean; prioritizeSunday: boolean; maximizeNight: boolean; spesenDaysTarget: number; isEinzelfahrer: boolean }[] = []
  for (const i of [1, 2]) {
    const driverId = String(formData.get(`driver${i}Id`) ?? '')
    if (!driverId) continue
    const breakOverrideRaw = String(formData.get(`driver${i}BreakMinutes`) ?? '').trim()
    targets.push({
      driverId,
      totalHours: parseFloat(String(formData.get(`driver${i}TotalHours`) ?? '0')) || 0,
      sundayHours: parseFloat(String(formData.get(`driver${i}SundayHours`) ?? '0')) || 0,
      commuteMinutes: parseInt(String(formData.get(`driver${i}CommuteMinutes`) ?? '30'), 10) || 30,
      breakMinutesOverride: breakOverrideRaw ? parseInt(breakOverrideRaw, 10) : null,
      calculateExpenses: formData.get(`driver${i}CalculateExpenses`) === 'on',
      spesenDaysTarget: parseFloat(String(formData.get(`driver${i}SpesenDaysTarget`) ?? '0')) || 0,
      isEinzelfahrer: formData.get(`driver${i}IsEinzelfahrer`) === 'on',
      prioritizeDemand: formData.get(`driver${i}PrioritizeDemand`) === 'on',
      prioritizeSunday: formData.get(`driver${i}PrioritizeSunday`) === 'on',
      maximizeNight: formData.get(`driver${i}MaximizeNight`) === 'on'
    })
  }

  if (targets.length === 0) return { ...HOURS_EMPTY_STATE, error: 'Bitte mindestens einen Fahrer mit Stundenzahl angeben.' }

  try {
    const result = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
      const [vehicle, drivers, settings, demandProfilesRaw] = await Promise.all([
        tx.vehicle.findUnique({ where: { id: vehicleId } }),
        tx.driver.findMany({ where: { id: { in: targets.map((t) => t.driverId) } } }),
        tx.companySettings.findUnique({ where: { companyId: user.companyId! } }),
        tx.demandProfile.findMany({ where: { companyId: user.companyId } })
      ])
      if (!vehicle) throw new Error('Fahrzeug nicht gefunden.')

      const nightStart = settings?.nightStart ?? '22:00'
      const nightEnd = settings?.nightEnd ?? '06:00'
      const minRestHours = settings?.minRestHours ?? 11
      const demandProfiles: DemandProfileInput[] = demandProfilesRaw.map((p) => ({
        weekday: p.weekday, startTime: p.startTime, endTime: p.endTime, level: p.level as any
      }))

      const driverNameById = new Map(drivers.map((d) => [d.id, `${d.firstName} ${d.lastName}`]))
      const driverRateById = new Map(drivers.map((d) => [d.id, d.hourlyRate ?? null]))
      const driverEmployeeNumberById = new Map(drivers.map((d) => [d.id, d.employeeNumber ?? null]))
      const blockedDates = new Set<string>()
      const warnings: string[] = []
      const allRows: HoursPreviewRow[] = []
      const allDays = daysInMonthList(year, month)

      // Vollzeit-Fahrer (>=100 Std., feste Fr/Sa/So-Wochenend-Vorlage)
      // zuerst verarbeiten - unabhängig von der Reihenfolge im Formular.
      // Sonst könnte ein zuerst verarbeiteter Minijobber (der über sein
      // eigenes Sonntagsstunden-Feld ebenfalls einzelne Sonntage
      // beansprucht) dem Vollzeit-Fahrer die für seine Pflicht-Vorlage
      // benötigten Wochenendtage wegnehmen.
      const orderedTargets = [...targets].sort((a, b) => (b.isEinzelfahrer ? 1 : 0) - (a.isEinzelfahrer ? 1 : 0))

      for (const t of orderedTargets) {
        const name = driverNameById.get(t.driverId) ?? '—'
        const rate = driverRateById.get(t.driverId) ?? null
        const employeeNumber = driverEmployeeNumberById.get(t.driverId) ?? null
        const { shifts, warning } = generateHoursBasedSchedule(
          year, month - 1, { ...t, driverName: name },
          blockedDates, nightStart, nightEnd, minRestHours, demandProfiles
        )
        if (warning) warnings.push(`${name}: ${warning}`)

        const shiftsByDate = new Map<string, HoursShift>(shifts.map((s) => [s.date, s]))
        shifts.forEach((s) => blockedDates.add(s.date))

        allDays.forEach((dateStr) => {
          const isSunday = new Date(dateStr).getDay() === 0
          const s = shiftsByDate.get(dateStr)
          if (s) {
            allRows.push({
              ...s,
              driverId: t.driverId,
              driverName: name,
              vehiclePlate: vehicle.licensePlate,
              isFree: false,
              isSunday,
              isNightShift: isNightShiftRow(minToClock(s.startMin), minToClock(s.endMin), nightStart, nightEnd),
              hourlyRate: rate,
              employeeNumber,
              calculateExpenses: t.calculateExpenses
            })
          } else {
            allRows.push({
              date: dateStr,
              driverId: t.driverId,
              driverName: name,
              vehiclePlate: vehicle.licensePlate,
              isFree: true,
              isSunday,
              isNightShift: false,
              hourlyRate: rate,
              employeeNumber,
              calculateExpenses: t.calculateExpenses
            })
          }
        })
      }

      allRows.sort((a, b) => a.date.localeCompare(b.date) || a.driverName.localeCompare(b.driverName))
      return { vehicleId, shifts: allRows, warnings }
    })

    return { ...result, error: null }
  } catch (err) {
    return { ...HOURS_EMPTY_STATE, error: (err as Error).message }
  }
}

export async function applyHoursPlanning(formData: FormData) {
  const user = await requireCompanyUser()

  const vehicleId = String(formData.get('vehicleId') ?? '')
  const raw = String(formData.get('shiftsJson') ?? '[]')
  const rows: HoursPreviewRow[] = JSON.parse(raw)
  const shifts = rows.filter(
    (r): r is HoursPreviewRow & Required<Pick<HoursShift, 'startMin' | 'endMin' | 'breakMinutes' | 'breaks' | 'netHours' | 'commuteMinutes'>> =>
      !r.isFree && r.startMin != null && r.endMin != null
  )

  if (!vehicleId) throw new Error('Kein Fahrzeug ausgewählt.')
  if (shifts.length === 0) throw new Error('Keine Schichten zum Übernehmen vorhanden.')
  const missingDriver = shifts.find((s) => !s.driverId)
  if (missingDriver) throw new Error(`Schicht am ${missingDriver.date} hat keinen Fahrer zugeordnet.`)

  try {
    await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
      // Vor dem Einfügen: bestehende Schichten für exakt dieselben
      // Fahrzeug+Datum-Kombinationen löschen. Ohne das würde erneutes
      // "Übernehmen" (z. B. nach nochmaligem Generieren desselben Monats)
      // die alten Schichten NICHT ersetzen, sondern zusätzlich duplizieren.
      const affectedDates = Array.from(new Set(shifts.map((s) => s.date))).map(parseLocalDate)
      if (affectedDates.length > 0) {
        await tx.shift.deleteMany({
          where: { vehicleId, date: { in: affectedDates } }
        })
      }

      for (const s of shifts) {
        const shift = await tx.shift.create({
          data: {
            companyId: user.companyId,
            vehicleId,
            driverId: s.driverId,
            date: parseLocalDate(s.date),
            start: minToClock(s.startMin),
            end: minToClock(s.endMin),
            breakMinutes: s.breakMinutes,
            commuteMinutes: s.commuteMinutes,
            generated: true,
            shiftName: 'Stundenbasiert (Dokumentation)'
          }
        })
        if (s.breaks.length > 0) {
          await tx.shiftBreak.createMany({ data: s.breaks.map((b) => ({ shiftId: shift.id, start: b.start, end: b.end })) })
        }
      }
    })
  } catch (err) {
    // Ausführlich in die Server-Logs schreiben (Vercel -> "Runtime Logs"),
    // damit sich der genaue Fehler beim nächsten Mal sofort erkennen lässt,
    // statt nur den generischen "Application error" zu sehen.
    console.error('Dienstplan-Übernahme fehlgeschlagen:', {
      vehicleId,
      shiftCount: shifts.length,
      sampleShift: shifts[0],
      error: err
    })
    throw new Error(`Dienstplan konnte nicht übernommen werden: ${(err as Error).message}`)
  }

  revalidatePath('/dienstplan')
}

/**
 * Löscht alle gespeicherten Schichten eines Fahrers für einen bestimmten
 * Monat (unabhängig vom Fahrzeug) - für die "ohne viel Aufwand löschen"
 * Anforderung: ein Klick pro Fahrer/Monat statt einzelner Schicht-Löschung.
 */
export async function deleteDriverMonthShifts(formData: FormData) {
  const user = await requireCompanyUser()
  const driverId = String(formData.get('driverId') ?? '')
  const year = parseInt(String(formData.get('year') ?? ''), 10)
  const month = parseInt(String(formData.get('month') ?? ''), 10) // 1-12
  if (!driverId || !year || !month) return

  const monthStart = new Date(year, month - 1, 1)
  const monthEnd = new Date(year, month, 0)

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
    await tx.shift.deleteMany({
      where: { driverId, date: { gte: monthStart, lte: monthEnd } }
    })
  })

  revalidatePath('/dienstplan')
}

/** Löscht ALLE gespeicherten Schichten (aller Fahrer) für einen Monat. */
export async function deleteAllMonthShifts(formData: FormData) {
  const user = await requireCompanyUser()
  const year = parseInt(String(formData.get('year') ?? ''), 10)
  const month = parseInt(String(formData.get('month') ?? ''), 10) // 1-12
  if (!year || !month) return

  const monthStart = new Date(year, month - 1, 1)
  const monthEnd = new Date(year, month, 0)

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
    await tx.shift.deleteMany({
      where: { date: { gte: monthStart, lte: monthEnd } }
    })
  })

  revalidatePath('/dienstplan')
}
