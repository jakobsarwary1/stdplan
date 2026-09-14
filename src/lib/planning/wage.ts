// EINE gemeinsame Lohn-/Stundenrechnung für Bildschirm-Vorschau, Excel-Export
// UND die Lohnabrechnung. Vorher lag die Rechnung doppelt in HoursPlanningForm
// (computeSurcharges/computeExtendedStats) und als gespiegelte Excel-Formeln –
// das driftete auseinander. Ab jetzt ist DIESE Datei die einzige Quelle.
//
// Geschäftsregel (Jakob, 14.09.2026):
//   • Bezahlte Stunden = Beginn→Ende (die volle Schichtspanne). Die Pause ist
//     BEZAHLT und bleibt drin; der Arbeitsweg ist NIE bezahlt und zählt NIE in
//     die Stundensumme (er dient nur der Ruhezeit-/Spesenbetrachtung).
//   • Zuschläge nach § 3b EStG laufen dagegen NUR auf die tatsächliche
//     ARBEITSZEIT ohne Pause – die Pause ist keine Arbeitszeit und bekommt
//     keinen (steuerfreien) Zuschlag.
//   • Krankenstunden (Entgeltfortzahlung § 3 EntgFG) zählen zum Grundlohn,
//     aber ohne Zuschläge.
//
// Reines TypeScript ohne Server-/Client-Abhängigkeiten, damit es überall läuft.

export type WageBreak = { start: number; end: number } // Minuten seit Schichtbeginn

export type WageShiftInput = {
  date: string // "YYYY-MM-DD" – Kalendertag des Schichtbeginns
  startMin: number // Minuten seit Mitternacht des `date`
  endMin: number // kann > 1440 sein (Übernachtschicht)
  breaks: WageBreak[]
}

export type ShiftHours = {
  /** Schichtspanne Beginn→Ende – Pause bezahlt, Weg raus. Basis des Grundlohns. */
  paidHours: number
  /** Spanne minus Pause = reine Arbeitszeit. Basis der § 3b-Zuschläge. */
  workedHours: number
  breakHours: number
  night25: number // Arbeitszeit in 04–06 und 20–24 Uhr
  night40: number // Arbeitszeit in 00–04 Uhr (steuerfrei)
  sunday50: number // Arbeitszeit an Sonntagen
  holiday125: number // Arbeitszeit an Feiertagen (nicht zusätzlich Sonntag)
}

const HOUR_MS = 3600000
const DAY_MS = 86400000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Stundenaufschlüsselung EINER Schicht. Die Zuschlagszuordnung (Nacht/Sonntag/
 * Feiertag) ist identisch zur bisherigen computeSurcharges-Logik: die Schicht
 * wird um die Pausenblöcke gekürzt und dann tag-/fensterweise ausgewertet.
 * Fällt ein Feiertag auf einen Sonntag, zählt die Stunde NUR beim Sonntag
 * (höherwertig, kein Doppelzählen).
 */
export function computeShiftHours(shift: WageShiftInput, holidayDates: Set<string> = new Set()): ShiftHours {
  const [y, m, d] = shift.date.split('-').map(Number)
  const shiftStart = new Date(y, m - 1, d, 0, shift.startMin, 0, 0)
  const shiftEnd = new Date(y, m - 1, d, 0, shift.endMin, 0, 0)

  const paidHours = Math.max(0, (shiftEnd.getTime() - shiftStart.getTime()) / HOUR_MS)

  // Arbeitsintervalle = Schicht minus Pausenblöcke.
  let workIntervals: { start: Date; end: Date }[] = [{ start: shiftStart, end: shiftEnd }]
  ;(shift.breaks ?? []).forEach((b) => {
    const bStart = new Date(shiftStart.getTime() + b.start * 60000)
    const bEnd = new Date(shiftStart.getTime() + b.end * 60000)
    workIntervals = workIntervals.flatMap((w) => {
      if (bEnd <= w.start || bStart >= w.end) return [w]
      const parts: { start: Date; end: Date }[] = []
      if (bStart > w.start) parts.push({ start: w.start, end: bStart })
      if (bEnd < w.end) parts.push({ start: bEnd, end: w.end })
      return parts
    })
  })

  const ov = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
  let workedHours = 0
  let night25 = 0
  let night40 = 0
  let sunday50 = 0
  let holiday125 = 0

  workIntervals.forEach((w) => {
    workedHours += (w.end.getTime() - w.start.getTime()) / HOUR_MS
    let cursor = new Date(w.start)
    while (cursor < w.end) {
      const dayBase = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
      const nextDay = new Date(dayBase.getTime() + DAY_MS)
      const segEnd = new Date(Math.min(w.end.getTime(), nextDay.getTime()))
      const segStartMin = (cursor.getTime() - dayBase.getTime()) / 60000
      const segEndMin = (segEnd.getTime() - dayBase.getTime()) / 60000
      const isSunday = dayBase.getDay() === 0
      const dateStr = `${dayBase.getFullYear()}-${pad2(dayBase.getMonth() + 1)}-${pad2(dayBase.getDate())}`
      const isHoliday = holidayDates.has(dateStr)
      night40 += ov(segStartMin, segEndMin, 0, 240) / 60
      night25 += (ov(segStartMin, segEndMin, 240, 360) + ov(segStartMin, segEndMin, 1200, 1440)) / 60
      if (isSunday) sunday50 += (segEndMin - segStartMin) / 60
      else if (isHoliday) holiday125 += (segEndMin - segStartMin) / 60
      cursor = segEnd
    }
  })

  return { paidHours, workedHours, breakHours: paidHours - workedHours, night25, night40, sunday50, holiday125 }
}

export type MonthlyHours = {
  paidHours: number // Σ Schichtspannen (bezahlt, Pause drin, Weg raus)
  workedHours: number // Σ reine Arbeitszeit
  sickHours: number // Entgeltfortzahlung § 3 EntgFG
  totalPaidHours: number // paidHours + sickHours – die bezahlte Gesamtstundenzahl
  night25: number
  night40: number
  sunday50: number
  holiday125: number
}

/** Summiert die Stunden mehrerer Schichten (+ optional Krankenstunden). */
export function sumShiftHours(
  shifts: WageShiftInput[],
  holidayDates: Set<string> = new Set(),
  sickHours = 0
): MonthlyHours {
  const acc = { paidHours: 0, workedHours: 0, night25: 0, night40: 0, sunday50: 0, holiday125: 0 }
  shifts.forEach((s) => {
    const h = computeShiftHours(s, holidayDates)
    acc.paidHours += h.paidHours
    acc.workedHours += h.workedHours
    acc.night25 += h.night25
    acc.night40 += h.night40
    acc.sunday50 += h.sunday50
    acc.holiday125 += h.holiday125
  })
  return { ...acc, sickHours, totalPaidHours: acc.paidHours + sickHours }
}

/** Gesetzliche Zuschlagsprozentsätze nach § 3b EStG (als Aufschlag auf den Stundenlohn). */
export const SURCHARGE_FACTORS = { night25: 0.25, night40: 0.4, sunday50: 0.5, holiday125: 1.25 } as const

export type WageBreakdown = MonthlyHours & {
  hourlyRate: number | null
  /** (paidHours + sickHours) × Stundenlohn */
  grundlohn: number | null
  night25Amount: number | null
  night40Amount: number | null
  sunday50Amount: number | null
  holiday125Amount: number | null
  surchargeTotal: number | null
  /** Grundlohn + alle Zuschläge (auch die steuerfreien Nachtzuschläge, die ja ausgezahlt werden). */
  brutto: number | null
}

/**
 * Bruttolohn aus Stundenaufschlüsselung + Stundenlohn. Ohne hinterlegten
 * Stundenlohn bleiben alle Beträge null (nur die Stunden stehen dann).
 */
export function computeWage(hours: MonthlyHours, hourlyRate: number | null): WageBreakdown {
  if (hourlyRate == null || !Number.isFinite(hourlyRate)) {
    return {
      ...hours, hourlyRate: null, grundlohn: null,
      night25Amount: null, night40Amount: null, sunday50Amount: null, holiday125Amount: null,
      surchargeTotal: null, brutto: null
    }
  }
  const grundlohn = hours.totalPaidHours * hourlyRate
  const night25Amount = hours.night25 * hourlyRate * SURCHARGE_FACTORS.night25
  const night40Amount = hours.night40 * hourlyRate * SURCHARGE_FACTORS.night40
  const sunday50Amount = hours.sunday50 * hourlyRate * SURCHARGE_FACTORS.sunday50
  const holiday125Amount = hours.holiday125 * hourlyRate * SURCHARGE_FACTORS.holiday125
  const surchargeTotal = night25Amount + night40Amount + sunday50Amount + holiday125Amount
  return {
    ...hours, hourlyRate, grundlohn,
    night25Amount, night40Amount, sunday50Amount, holiday125Amount,
    surchargeTotal, brutto: grundlohn + surchargeTotal
  }
}

// ---------- Minijob-Pauschalabgaben (Arbeitgeberseite, § 249b SGB V / § 172 SGB VI) ----------

export type MinijobRates = {
  kv: number // Pauschalbeitrag Krankenversicherung (13 %)
  rv: number // Pauschalbeitrag Rentenversicherung (15 %)
  u1: number // Umlage U1 (Entgeltfortzahlung Krankheit)
  u2: number // Umlage U2 (Mutterschaft)
  insolvenz: number // Insolvenzgeldumlage
  pauschsteuer: number // Einheitliche Pauschsteuer (2 %)
  other: number // sonstige
}

export type MinijobEmployerCost = MinijobRates & {
  totalRate: number
  totalContrib: number // Summe aller Pauschalabgaben in Euro
  employerTotalCost: number // Bruttolohn + Pauschalabgaben = tatsächliche Arbeitgeberkosten
}

/**
 * Arbeitgeber-Pauschalabgaben eines Minijobs auf den Bruttolohn. Alle Sätze
 * kommen aus den Firmen- bzw. Fahrer-Einstellungen (nichts fest verdrahtet),
 * die Feldnamen entsprechen `CompanySettings`/`MinijobSettings` im Schema.
 */
export function computeMinijobEmployerCost(brutto: number, rates: MinijobRates): MinijobEmployerCost {
  const kv = brutto * rates.kv
  const rv = brutto * rates.rv
  const u1 = brutto * rates.u1
  const u2 = brutto * rates.u2
  const insolvenz = brutto * rates.insolvenz
  const pauschsteuer = brutto * rates.pauschsteuer
  const other = brutto * rates.other
  const totalContrib = kv + rv + u1 + u2 + insolvenz + pauschsteuer + other
  const totalRate = rates.kv + rates.rv + rates.u1 + rates.u2 + rates.insolvenz + rates.pauschsteuer + rates.other
  return { kv, rv, u1, u2, insolvenz, pauschsteuer, other, totalRate, totalContrib, employerTotalCost: brutto + totalContrib }
}
