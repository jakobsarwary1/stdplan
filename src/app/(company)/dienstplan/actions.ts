'use server'

import { revalidatePath } from 'next/cache'
import { parseAbsences, type AbsenceKind } from '@/lib/planning/absence'
import { MIN_BREAK_MINUTES, MAX_BREAK_MINUTES } from '@/lib/planning/breaks'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { generateSlotsForVehicle, type TemplateShiftInput } from '@/lib/planning/slots'
import { assignDriversToSlots, type AssignedSlot, type DriverInput, type ExistingShiftInput } from '@/lib/planning/assign'
import type { DemandProfileInput } from '@/lib/planning/demand'
import { generateHoursBasedSchedule, type HoursShift, type VehicleBusy } from '@/lib/planning/hoursMode'

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
        unavailability: d.unavailability.map((u) => ({ start: u.start, end: u.end })),
        hireDate: d.hireDate
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
  /** Krankenstunden des Fahrers im Monat (Entgeltfortzahlung) - je Zeile derselbe Monatswert. */
  sickHours?: number
  /** An freien Tagen: der im Kalender gewählte Grund der Abwesenheit. */
  absenceKind?: AbsenceKind | null
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

  const targets: { driverId: string; totalHours: number; sundayHours: number; nightHours: number; commuteMinutes: number; breakMinutesOverride: number | null; calculateExpenses: boolean; prioritizeDemand: boolean; prioritizeSunday: boolean; maximizeNight: boolean; spesenDaysTarget: number; isEinzelfahrer: boolean; excludedDates: string[]; maxFreeDays: number | null; absences: Map<string, AbsenceKind>; sickHours: number }[] = []
  // Wie viele Fahrer-Bloecke das Formular geschickt hat. Keine feste
  // Obergrenze mehr (frueher genau zwei); driverCount kommt aus dem Formular,
  // die Schleife laeuft zusaetzlich so lange weiter, wie noch Felder da sind -
  // so gehen auch aeltere Formulare ohne driverCount nicht verloren.
  const driverCount = Math.max(2, parseInt(String(formData.get('driverCount') ?? '2'), 10) || 2)
  for (let i = 1; i <= driverCount || formData.get(`driver${i}Id`) != null; i++) {
    const driverId = String(formData.get(`driver${i}Id`) ?? '')
    if (!driverId) continue
    const breakOverrideRaw = String(formData.get(`driver${i}BreakMinutes`) ?? '').trim()
    const excludedDatesRaw = String(formData.get(`driver${i}ExcludedDates`) ?? '')
    const maxFreeRaw = String(formData.get(`driver${i}MaxFreeDays`) ?? '').trim()
    // Der Kalender liefert "YYYY-MM-DD:art". Geplant wird an allen drei Arten
    // gleich (keine Schicht) – die Art wird nur zur Anzeige mitgeführt.
    const absences = parseAbsences(excludedDatesRaw)
    const sickHours = Math.max(0, parseFloat(String(formData.get(`driver${i}SickHours`) ?? '0')) || 0)
    targets.push({
      driverId,
      totalHours: parseFloat(String(formData.get(`driver${i}TotalHours`) ?? '0')) || 0,
      sundayHours: parseFloat(String(formData.get(`driver${i}SundayHours`) ?? '0')) || 0,
      nightHours: parseFloat(String(formData.get(`driver${i}NightHours`) ?? '0')) || 0,
      commuteMinutes: parseInt(String(formData.get(`driver${i}CommuteMinutes`) ?? '30'), 10) || 30,
      // Eine bewusst gesetzte Pause bleibt im zulässigen Rahmen von 30-120 Min.
      breakMinutesOverride: breakOverrideRaw
        ? Math.min(MAX_BREAK_MINUTES, Math.max(MIN_BREAK_MINUTES, parseInt(breakOverrideRaw, 10) || MIN_BREAK_MINUTES))
        : null,
      // Spesen sind abgeschaltet: keine Verpflegungsmehraufwand-Berechnung und
      // damit auch kein Zwang zu 8-10 Std. Gesamtzeit je Schicht.
      calculateExpenses: false,
      spesenDaysTarget: 0,
      isEinzelfahrer: formData.get(`driver${i}IsEinzelfahrer`) === 'on',
      prioritizeDemand: formData.get(`driver${i}PrioritizeDemand`) === 'on',
      prioritizeSunday: formData.get(`driver${i}PrioritizeSunday`) === 'on',
      maximizeNight: formData.get(`driver${i}MaximizeNight`) === 'on',
      excludedDates: Array.from(absences.keys()),
      sickHours,
      absences,
      // Leeres Feld = keine Vorgabe (null), nicht "0 freie Tage".
      maxFreeDays: maxFreeRaw === '' ? null : Math.max(0, parseInt(maxFreeRaw, 10) || 0)
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
      const driverHireDateById = new Map(drivers.map((d) => [d.id, d.hireDate ? d.hireDate.toISOString().slice(0, 10) : null]))
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
      // Zusätzlich der Fahrer mit den MEISTEN Stunden zuerst: Er ist der
      // Hauptfahrer des Wagens und bekommt die Schichtlage vorgegeben; die
      // Aushilfe legt sich anschließend in die verbliebenen Lücken (z. B.
      // Hauptfahrer nachts, Aushilfe tagsüber am selben Datum).
      const orderedTargets = [...targets].sort(
        (a, b) => ((b.isEinzelfahrer ? 1 : 0) - (a.isEinzelfahrer ? 1 : 0)) || (b.totalHours - a.totalHours)
      )

      // Belegung des FAHRZEUGS als Zeitfenster je Datum. Früher wurde der
      // ganze Tag gesperrt, sobald ein Fahrer dort eine Schicht hatte -
      // dadurch konnten zwei Fahrer nie am selben Tag fahren, auch nicht
      // Nachtschicht plus Tagschicht.
      const vehicleBusy: VehicleBusy = new Map()

      for (const t of orderedTargets) {
        const name = driverNameById.get(t.driverId) ?? '—'
        const rate = driverRateById.get(t.driverId) ?? null
        const employeeNumber = driverEmployeeNumberById.get(t.driverId) ?? null
        const hireDate = driverHireDateById.get(t.driverId) ?? null
        // Selbst markierte "Frei"-Tage zaehlen gegen die Obergrenze im
        // Formular; Urlaub und Krankheit nicht.
        const preFreeDays = Array.from(t.absences.values()).filter((art) => art === 'frei').length
        const { shifts, warning } = generateHoursBasedSchedule(
          year, month - 1, { ...t, driverName: name, hireDate, preFreeDays },
          blockedDates, nightStart, nightEnd, minRestHours, demandProfiles, vehicleBusy
        )
        if (warning) warnings.push(`${name}: ${warning}`)

        const shiftsByDate = new Map<string, HoursShift>(shifts.map((s) => [s.date, s]))
        // Das Fahrzeug für die gefahrenen ZEITEN belegen, nicht für den
        // ganzen Tag – sonst bekäme der zweite Fahrer diesen Tag gar nicht.
        shifts.forEach((s) => {
          const liste = vehicleBusy.get(s.date) ?? []
          liste.push({ start: s.startMin, end: s.endMin })
          vehicleBusy.set(s.date, liste)
        })

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
              calculateExpenses: t.calculateExpenses,
              sickHours: t.sickHours
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
              calculateExpenses: t.calculateExpenses,
              sickHours: t.sickHours,
              // Vom Nutzer markierte Tage behalten ihren Grund; alle übrigen
              // freien Tage entstehen aus der Planung und sind schlicht "Frei".
              absenceKind: t.absences.get(dateStr) ?? 'frei'
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
