import { requiredBreakMinutes, positionBreak } from './breaks'
import { demandScore, type DemandProfileInput } from './demand'

export type HoursTarget = {
  driverId: string
  driverName: string
  hireDate: string | null // "YYYY-MM-DD" - Tage davor dürfen keine Schicht erhalten (Fahrer noch nicht eingetreten)
  totalHours: number
  sundayHours: number
  commuteMinutes: number
  breakMinutesOverride: number | null // bewusst gewählte, längere Pause (z. B. Split-Shift) - nie unter das gesetzliche Minimum
  calculateExpenses: boolean // Spesen/Verpflegungsmehraufwand berechnen - erzwingt 8-10h Gesamtzeit; sonst nur 5-8h Netto ohne Gesamtzeit-Zwang
  prioritizeDemand: boolean // Startzeit anhand der Nachfrageprofile wählen (z. B. für Einzelfahrer-Fahrzeuge)
  prioritizeSunday: boolean // Sonntagsüberlappung zusätzlich gezielt maximieren (unabhängig von Nachtzuschlag/Nachfrage), bleibt aber innerhalb der harten sundayHours-Obergrenze
  maximizeNight: boolean
  spesenDaysTarget?: number // optionale Ziel-Anzahl an Spesen-Tagen (>=8h Brutto) - direkt als Tageszahl, keine Euro-Umrechnung mehr
  isEinzelfahrer?: boolean // explizit gesetzt: feste Fr/Sa/So-Vorlage, 8h-Mindestgesamtzeit, "nie 3 Tage frei" - NICHT mehr automatisch aus der Stundenzahl abgeleitet
}

export type HoursShift = {
  driverId: string
  date: string // YYYY-MM-DD
  startMin: number
  endMin: number
  breakMinutes: number
  breaks: { start: number; end: number }[]
  netHours: number
  commuteMinutes: number
}

// Zielspanne für die GESAMTZEIT (Netto + Pause + Arbeitsweg) je Schicht -
// z. B. für die Berechnung von Verpflegungsmehraufwand/Speisekosten. Die
// Obergrenze (10h) gilt IMMER, die Untergrenze (8h) nur bei aktivierten
// Spesen.
const TARGET_TOTAL_MIN = 8
const TARGET_TOTAL_MAX = 10
const DEFAULT_COMMUTE_MINUTES = 30
const BUSINESS_MIN_BREAK = 30
const BASE_MIN_NET = 5
const BASE_MAX_NET = 8
// Feste Wochenend-Vorlage (siehe FIXED_WEEKEND_TEMPLATE weiter unten) -
// hier als Konstanten, damit die Verteilungsrechnung für Montag-Donnerstag
// diese fixen Werte korrekt vom Gesamtbudget abziehen kann.
const FRI_FIXED_NET_HOURS = 7.5
const SAT_FIXED_NET_HOURS = 6
const SUN_FIXED_NET_HOURS = 6
const BREAK_STEPS = [30, 45, 60, 90, 120]
const MAX_BREAK_STEP_MINUTES = BREAK_STEPS[BREAK_STEPS.length - 1]
const START_WINDOW = { earliest: 4 * 60, latest: 22 * 60 } // 04:00-22:00, in 15-Minuten-Schritten durchsucht

function daysInMonth(year: number, month0: number): Date[] {
  const days: Date[] = []
  const d = new Date(year, month0, 1)
  while (d.getMonth() === month0) {
    days.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  return days
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Bewertet ein Zeitfenster [startMin, endMin) (kann über mehrere
 * Kalendertage reichen) nach seinem TATSÄCHLICHEN Zuschlagswert, mit den
 * echten gesetzlichen Prozentsätzen als Gewichtung: 0,50 für
 * Sonntagsminuten, 0,40 für steuerfreie Nachtminuten (00-04 Uhr), 0,25 für
 * reguläre Nachtminuten (20-24 + 04-06 Uhr). Das lässt aufeinanderfolgende
 * Tage (z. B. Freitag/Samstag/Sonntag) natürlich zusammenspielen, ohne sie
 * separat behandeln zu müssen: eine Schicht, die von Samstagabend in den
 * Sonntagmorgen reicht, bekommt automatisch einen Bonus für die
 * Sonntagsminuten, während eine Sonntagsschicht, die weit in den Montag
 * hineinreicht, für die verlorenen Sonntagsminuten "bestraft" wird - der
 * Algorithmus wägt das von selbst gegeneinander ab.
 */
function surchargeValueScore(startMin: number, endMin: number, weekday: number, sundayWeight = 0.5): number {
  let score = 0
  let cursor = startMin
  while (cursor < endMin) {
    const dayIndex = Math.floor(cursor / 1440)
    const localStart = cursor - dayIndex * 1440
    const localEnd = Math.min(endMin, (dayIndex + 1) * 1440) - dayIndex * 1440
    const isSunday = (((weekday + dayIndex) % 7) + 7) % 7 === 0
    const ov = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
    const taxFreeMin = ov(localStart, localEnd, 0, 240)
    const regularNightMin = ov(localStart, localEnd, 240, 360) + ov(localStart, localEnd, 1200, 1440)
    score += taxFreeMin * 0.4 + regularNightMin * 0.25
    if (isSunday) score += (localEnd - localStart) * sundayWeight
    cursor = (dayIndex + 1) * 1440
  }
  return score
}

/** Wie viele Minuten von [startMin, endMin) (kann mehrere Tage überspannen) auf einen Sonntag fallen. */
function sundayOverlapMinutes(startMin: number, endMin: number, weekday: number): number {
  let total = 0
  let cursor = startMin
  while (cursor < endMin) {
    const dayIndex = Math.floor(cursor / 1440)
    const localStart = cursor - dayIndex * 1440
    const localEnd = Math.min(endMin, (dayIndex + 1) * 1440) - dayIndex * 1440
    const isSunday = (((weekday + dayIndex) % 7) + 7) % 7 === 0
    if (isSunday) total += localEnd - localStart
    cursor = (dayIndex + 1) * 1440
  }
  return total
}

// Wählt zufällig `count` Tage aus `pool` aus (ohne Zurücklegen) - für eine
// abwechslungsreiche, aber weiterhin plausible Verteilung der Arbeitstage
// über den Monat.
/**
 * Wählt `count` Tage aus einem sortierten Pool nach dem Prinzip "Rand vor
 * Mitte": Tage am Anfang und Ende des Pools (z. B. erste/letzte Sonntage
 * im Monat) haben Vorrang vor denen in der Mitte.
 */
function pickDaysEdgeFirst(pool: Date[], count: number): Date[] {
  const sorted = [...pool].sort((a, b) => a.getTime() - b.getTime())
  if (count >= sorted.length) return sorted
  const center = (sorted.length - 1) / 2
  const priorityIndices = Array.from({ length: sorted.length }, (_, i) => i)
    .sort((a, b) => Math.abs(b - center) - Math.abs(a - center))
  const chosenIndices = priorityIndices.slice(0, count)
  return chosenIndices.map((i) => sorted[i]).sort((a, b) => a.getTime() - b.getTime())
}

function pickRandomDays(pool: Date[], count: number): Date[] {
  const copy = [...pool]
  const chosen: Date[] = []
  while (chosen.length < count && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length)
    chosen.push(copy.splice(idx, 1)[0])
  }
  return chosen.sort((a, b) => a.getTime() - b.getTime())
}

/**
 * Wählt Arbeitstage in BLÖCKEN von 3-5 aufeinanderfolgenden Tagen aus dem
 * Pool (statt einzeln verstreut über den Monat), mit 1-2 freien Tagen
 * zwischen den Blöcken. Wird bei hohem Stundenvolumen (>= 150 Std./Monat)
 * verwendet, da ein Muster mit vielen kurzen Einzeltagen dazwischen für
 * Vollzeit-nahe Fahrer unpraktisch ist - zusammenhängende Arbeitsblöcke
 * sind alltagstauglicher.
 */
function pickBlockDays(pool: Date[], count: number): Date[] {
  const sorted = [...pool].sort((a, b) => a.getTime() - b.getTime())
  const chosen: Date[] = []
  let i = 0
  while (chosen.length < count && i < sorted.length) {
    const remaining = count - chosen.length
    const blockLen = Math.min(3 + Math.floor(Math.random() * 3), remaining, sorted.length - i) // 3, 4 oder 5 Tage
    for (let k = 0; k < blockLen; k++) chosen.push(sorted[i + k])
    i += blockLen
    i += 1 + Math.floor(Math.random() * 2) // 1-2 Tage Pause zwischen den Blöcken überspringen
  }
  return chosen
}

/**
 * Wählt Arbeitstage so, dass jede Kalenderwoche im Monat MÖGLICHST DIE
 * GLEICHE ANZAHL an Arbeitstagen bekommt (Gesamtzahl Schichten ÷ Anzahl
 * Wochen im Zeitraum) - nicht die gleiche Stundenzahl pro Woche (die darf
 * variieren), sondern die gleiche TAGESANZAHL. Ein eventueller Rest wird
 * auf zufällig ausgewählte Wochen verteilt (je 1 Tag mehr), statt alles in
 * eine einzelne Woche zu packen.
 */
// Prioritätsreihenfolge bei der Wochentag-Auswahl: Samstag zuerst, dann
// Freitag, dann die übrigen Werktage - Sonntag wird hier nicht gelistet,
// da er über die eigene, dedizierte Sonntagsstunden-Zuteilung bereits
// separat (und mit eigener Priorität, sofern Sonntagsstunden angegeben
// sind) behandelt wird, nicht Teil dieses Werktags-Pools ist.
const WEEKDAY_PRIORITY: Record<number, number> = { 6: 0, 5: 1, 1: 2, 2: 3, 3: 4, 4: 5, 0: 6 }

function pickDaysWithWeeklyVariation(pool: Date[], count: number): Date[] {
  const sorted = [...pool].sort((a, b) => a.getTime() - b.getTime())
  if (sorted.length === 0 || count <= 0) return []

  // Tage nach Kalenderwoche gruppieren (Woche beginnt Montag)
  const weekOf = (d: Date) => {
    const monday = new Date(d)
    const diff = (d.getDay() + 6) % 7 // Montag = 0
    monday.setDate(d.getDate() - diff)
    return monday.toISOString().slice(0, 10)
  }
  const weeks = new Map<string, Date[]>()
  sorted.forEach((d) => {
    const key = weekOf(d)
    weeks.set(key, [...(weeks.get(key) ?? []), d])
  })
  const weekKeys = Array.from(weeks.keys()).sort()
  const numWeeks = weekKeys.length
  if (numWeeks === 0) return []

  // Gleichmäßige Grundverteilung (Gesamtzahl ÷ Wochenzahl), Rest zufällig
  // auf einzelne Wochen verteilen (je maximal 1 Tag mehr) statt alles in
  // eine Woche zu packen.
  const baseDaysPerWeek = Math.floor(count / numWeeks)
  let remainder = count % numWeeks
  // Priorität: erste und letzte Woche(n) des Zeitraums bekommen den Extra-
  // Tag zuerst, die mittleren Wochen zuletzt (Abstand von der Monatsmitte
  // - je größer der Abstand zur Mitte, desto höher die Priorität).
  const center = (numWeeks - 1) / 2
  const priorityIndices = Array.from({ length: numWeeks }, (_, i) => i)
    .sort((a, b) => Math.abs(b - center) - Math.abs(a - center))
  const extraWeeks = new Set(priorityIndices.slice(0, remainder).map((i) => weekKeys[i]))

  const chosen: Date[] = []
  for (const key of weekKeys) {
    const daysInWeek = weeks.get(key)!
    const wanted = Math.min(daysInWeek.length, baseDaysPerWeek + (extraWeeks.has(key) ? 1 : 0))
    // Innerhalb der Woche nach Priorität sortiert auswählen (Sa, Fr, Mo,
    // Di, Mi, Do) statt rein zufällig - Samstag/Freitag werden so
    // bevorzugt belegt, wenn nicht alle Wochentage gebraucht werden.
    const prioritized = [...daysInWeek].sort((a, b) => WEEKDAY_PRIORITY[a.getDay()] - WEEKDAY_PRIORITY[b.getDay()])
    chosen.push(...prioritized.slice(0, wanted))
  }

  // Falls durch zu wenige verfügbare Tage in einzelnen Wochen (z. B.
  // Monatsanfang/-ende mit nur 1-2 Tagen) die Zielzahl nicht ganz erreicht
  // wurde, die fehlenden Tage aus den übrigen, noch nicht gewählten Tagen
  // auffüllen.
  if (chosen.length < count) {
    const chosenSet = new Set(chosen.map((d) => d.toISOString().slice(0, 10)))
    const leftover = sorted
      .filter((d) => !chosenSet.has(d.toISOString().slice(0, 10)))
      .sort((a, b) => WEEKDAY_PRIORITY[a.getDay()] - WEEKDAY_PRIORITY[b.getDay()])
    chosen.push(...leftover.slice(0, count - chosen.length))
  }

  return chosen.sort((a, b) => a.getTime() - b.getTime())
}

type DayContext = {
  date: Date
  dateStr: string
  weekday: number
  breakMinutes: number
  lowestWindow: { startMinOfDay: number; durationMinutes: number } | null
  maxNetMinutes: number // aus der 10h-Gesamtzeit-Obergrenze abgeleitet, IMMER berücksichtigt
  minNetMinutes: number // Basis 5 Std., an Fr/Sa ggf. höher wegen Mindest-Bruttoarbeitszeit
}

/**
 * Verteilt eine Ziel-Gesamtstundenzahl auf Tage, deren individuelle
 * Tagesobergrenze (`maxNetMinutes`, wegen unterschiedlich langer Pausen pro
 * Tag) variieren kann - damit die Monatssumme trotz der 10-Std.-Deckelung
 * an einzelnen Tagen weiterhin exakt erreicht wird (sofern rechnerisch
 * überhaupt möglich).
 */
function distributeHoursWithPerDayCap(
  days: DayContext[],
  totalTargetHours: number
): { hoursByDate: Map<string, number>; shortfallHours: number } {
  const map = new Map<string, number>()
  if (days.length === 0) return { hoursByDate: map, shortfallHours: totalTargetHours }

  const minHByDay = days.map((d) => Math.min(BASE_MAX_NET, d.minNetMinutes / 60))
  const maxHByDay = days.map((d, i) => Math.max(minHByDay[i], Math.min(BASE_MAX_NET, d.maxNetMinutes / 60)))

  let values = days.map((_, i) => minHByDay[i] + Math.random() * Math.max(0, maxHByDay[i] - minHByDay[i]))

  for (let iter = 0; iter < 200; iter++) {
    const sum = values.reduce((a, b) => a + b, 0)
    const diff = totalTargetHours - sum
    if (Math.abs(diff) < 0.01) break
    const room = values.map((v, i) => (diff > 0 ? maxHByDay[i] - v : v - minHByDay[i]))
    const totalRoom = room.reduce((a, b) => a + b, 0)
    if (totalRoom < 0.01) break
    values = values.map((v, i) => Math.max(minHByDay[i], Math.min(maxHByDay[i], v + diff * (room[i] / totalRoom))))
  }

  values = values.map((v, i) => Math.max(minHByDay[i], Math.min(maxHByDay[i], Math.round(v * 4) / 4))) // Viertelstunden-Raster
  const roundedSum = values.reduce((a, b) => a + b, 0)
  let residual = Math.round((totalTargetHours - roundedSum) * 4) / 4

  // Restbetrag (durch Rundung entstanden) auf Tage mit noch freier Kapazität verteilen.
  for (let i = 0; i < values.length && Math.abs(residual) > 0.01; i++) {
    const room = residual > 0 ? maxHByDay[i] - values[i] : values[i] - minHByDay[i]
    const take = residual > 0 ? Math.min(room, residual) : Math.max(-room, residual)
    values[i] += take
    residual -= take
  }

  days.forEach((d, i) => map.set(d.dateStr, values[i]))
  const delivered = values.reduce((a, b) => a + b, 0)
  return { hoursByDate: map, shortfallHours: Math.max(0, totalTargetHours - delivered) }
}

/**
 * Erzeugt einen stundenbasierten Dienstplan für EINEN Fahrer über einen
 * Monat: verteilt die gewünschte Gesamtstundenzahl (inkl. eines Anteils an
 * Sonntagsstunden) auf plausible Arbeitstage, plant die gesetzliche Pause
 * automatisch (§ 4 ArbZG) und wählt bei `maximizeNight` die Startzeit je
 * Tag so, dass möglichst viele Stunden in das Nachtfenster fallen.
 *
 * `blockedDates`: Tage, die für dieses Fahrzeug bereits durch einen anderen
 * Fahrer belegt sind (bei mehreren Fahrern am selben Fahrzeug) - werden
 * nicht erneut vergeben.
 */
function generateHoursBasedScheduleAttempt(
  year: number,
  month0: number, // 0-basiert (0 = Januar)
  target: HoursTarget,
  blockedDates: Set<string>,
  nightStart: string,
  nightEnd: string,
  minRestHours: number,
  demandProfiles: DemandProfileInput[] = [],
  targetFreeDaysFloor: number = 5
): { shifts: HoursShift[]; warning: string | null } {
  const commuteMinutes = target.commuteMinutes > 0 ? target.commuteMinutes : DEFAULT_COMMUTE_MINUTES

  const allDays = daysInMonth(year, month0).filter(
    (d) => !blockedDates.has(toDateStr(d)) && (!target.hireDate || toDateStr(d) >= target.hireDate)
  )

  // ---- Anzahl benötigter Tage grob schätzen (für die Tagesauswahl) ----
  // Bei Vollzeit (Spesen aktiv ODER Gesamtstundenziel >= 100 Std./Monat)
  // liegt die tatsächlich nutzbare Netto-Spanne enger bei [7,8] Std. statt
  // [5,8] Std. (siehe buildContext) - das MUSS hier ebenfalls einfließen,
  // sonst würden zu viele Tage gewählt und die Monatssumme durch die
  // erzwungene Mindeststunde pro Tag deutlich über das Ziel hinausschießen.
  const warnings: string[] = []

  // Die feste Fr/Sa/So-Wochenend-Vorlage und die "nie 3 Tage frei"-Regel
  // gelten NUR, wenn explizit als Einzelfahrer/Vollzeit markiert (Häkchen
  // im Formular) - NICHT mehr automatisch nur wegen einer Stundenzahl
  // >= 100. Ein Teilzeit-Fahrer mit z. B. 110 Std. soll NICHT ungefragt in
  // die Wochenend-Pflicht und die 8h-Zwangsregel rutschen, nur weil seine
  // Stundenzahl zufällig über der Schwelle liegt.
  const isEinzelfahrer = target.isEinzelfahrer === true
  const mustReachEightHoursGlobal = target.calculateExpenses
  const avgNet = mustReachEightHoursGlobal ? 6.75 : (BASE_MIN_NET + BASE_MAX_NET) / 2

  let chosenWeekdays: Date[]
  let remainingHours: number
  let numWeekdayShifts = 0
  let reservePool: Date[] = [] // ungenutzte Tage, die bei Bedarf nachträglich zur Unterbringung von Restsstunden hinzugenommen werden können
  let minijobSundayHoursByDate: Map<string, number> | null = null // dedizierte Sonntagsstunden im Minijob-Zweig (siehe unten)
  let restDayCountWasExpandedForFreeTarget = false // true, wenn mehr Tage als die Durchschnittsschätzung gewählt wurden, um das Freie-Tage-Ziel zu erreichen

  // Sonntag bekommt KEINE fest eingebrannte Nettozeit, sondern wird aus der
  // eingegebenen Sonntagsstundenzahl abgeleitet - abzüglich des TATSÄCHLICHEN
  // Samstag-Überlaufs (nicht nur grob geschätzt: die 8h-Mindestgesamtzeit-
  // Regel verlängert die Samstagspause bei Bedarf, was den Überlauf in den
  // Sonntag hinein verändert - das wird hier exakt nachgerechnet, damit die
  // Summe aus Samstag-Überlauf + Sonntags-eigener Schicht wirklich der
  // Eingabe entspricht, nicht nur ungefähr).
  const numSundaysInMonth = allDays.filter((d) => d.getDay() === 0).length
  const SAT_TEMPLATE_START = 22 * 60
  const SAT_TEMPLATE_NET_MINUTES = SAT_FIXED_NET_HOURS * 60
  const SAT_TEMPLATE_BREAK_START_OFFSET = 90 // 23:30, siehe FIXED_WEEKEND_TEMPLATE weiter unten
  const SAT_TEMPLATE_BASE_BREAK_MINUTES = 60

  let satActualBreakMinutes = SAT_TEMPLATE_BASE_BREAK_MINUTES
  const mustReachEightHoursForSat = target.calculateExpenses
  if (mustReachEightHoursForSat && SAT_TEMPLATE_NET_MINUTES + satActualBreakMinutes + commuteMinutes < TARGET_TOTAL_MIN * 60) {
    for (const step of BREAK_STEPS) {
      if (step <= satActualBreakMinutes) continue
      satActualBreakMinutes = step
      if (SAT_TEMPLATE_NET_MINUTES + satActualBreakMinutes + commuteMinutes >= TARGET_TOTAL_MIN * 60) break
    }
  }
  const satEndMin = SAT_TEMPLATE_START + SAT_TEMPLATE_NET_MINUTES + satActualBreakMinutes
  const satBreakStartAbs = SAT_TEMPLATE_START + SAT_TEMPLATE_BREAK_START_OFFSET
  const satBreakEndAbs = satBreakStartAbs + satActualBreakMinutes
  const satPostMidnightSpan = Math.max(0, satEndMin - 1440)
  const satBreakOverlapPostMidnight = Math.max(0, Math.min(satBreakEndAbs, satEndMin) - Math.max(satBreakStartAbs, 1440))
  const satSpilloverPerWeekendHours = (satPostMidnightSpan - satBreakOverlapPostMidnight) / 60

  const sundayDedicatedNetHours = target.sundayHours > 0 && numSundaysInMonth > 0
    ? Math.max(2, Math.min(8, (target.sundayHours - satSpilloverPerWeekendHours * numSundaysInMonth) / numSundaysInMonth))
    : SUN_FIXED_NET_HOURS // Standardwert, falls keine Sonntagsstunden vorgegeben sind

  if (isEinzelfahrer) {
    // Freitag, Samstag UND Sonntag sind Pflichttage mit der festen
    // Wochenend-Vorlage (siehe FIXED_WEEKEND_TEMPLATE weiter unten) -
    // IMMER, unabhängig von der eingegebenen Sonntagsstundenzahl. Diese
    // Eingabe dient nur noch als Vergleichswert in der Zusammenfassung.
    const mandatoryWeekend = allDays.filter((d) => [0, 5, 6].includes(d.getDay()))
    const fixedWeekendHoursTotal = mandatoryWeekend.reduce((sum, d) => {
      if (d.getDay() === 5) return sum + FRI_FIXED_NET_HOURS
      if (d.getDay() === 6) return sum + SAT_FIXED_NET_HOURS
      return sum + sundayDedicatedNetHours
    }, 0)

    remainingHours = Math.max(0, target.totalHours - fixedWeekendHoursTotal)
    const optionalMonThuPool = allDays.filter((d) => ![0, 5, 6].includes(d.getDay()))
    numWeekdayShifts = Math.min(optionalMonThuPool.length, Math.max(0, Math.round(remainingHours / avgNet)))
    chosenWeekdays = [...mandatoryWeekend, ...pickDaysWithWeeklyVariation(optionalMonThuPool, numWeekdayShifts)]
      .sort((a, b) => a.getTime() - b.getTime())
    const chosenSet = new Set(chosenWeekdays.map(toDateStr))
    reservePool = optionalMonThuPool.filter((d) => !chosenSet.has(toDateStr(d)))
  } else {
    // Minijob / kleines Stundenkontingent: normale flexible Verteilung ohne
    // Pflicht-Wochenende, ohne feste Vorlage, ohne "nie 3 Tage frei" -
    // Tage werden proportional zum Gesamtstundenziel zufällig gewählt.
    const sundayPool = allDays.filter((d) => d.getDay() === 0)
    const numSundayShifts = target.sundayHours > 0 ? Math.max(1, Math.ceil(target.sundayHours / 8)) : 0
    const chosenSundays = pickDaysEdgeFirst(sundayPool, Math.min(numSundayShifts, sundayPool.length))
    const chosenSundayDateStrs = new Set(chosenSundays.map(toDateStr))

    // Sonntage bekommen eine EIGENE, dedizierte Stundenzuteilung (flach
    // verteilt über die gewählten Sonntage) - sie dürfen NICHT einfach im
    // allgemeinen Werktags-Topf landen, dessen Budget (remainingHours)
    // die Sonntagsstunden ja bereits explizit ausschließt. Sonst würden
    // die Sonntage zwar als Arbeitstage gewählt, aber nie wirklich mit
    // Stunden befüllt - die Sonntagsstunden blieben faktisch unerreichbar.
    minijobSundayHoursByDate = new Map()
    {
      let remaining = target.sundayHours
      chosenSundays.forEach((d) => {
        const h = Math.max(0, Math.min(8, remaining))
        minijobSundayHoursByDate!.set(toDateStr(d), h)
        remaining -= h
      })
    }

    const restPool = allDays.filter((d) => d.getDay() !== 0 && !chosenSundayDateStrs.has(toDateStr(d)))
    remainingHours = Math.max(0, target.totalHours - target.sundayHours)
    const avgNetEstimate = Math.max(0, Math.round(remainingHours / avgNet))

    // Freie Tage sollen im Zielbereich 4-7 (idealerweise 5) liegen - reicht
    // die reine Durchschnittsschätzung dafür nicht aus (zu wenige Tage
    // gewählt), wird die Tagesanzahl von vornherein auf das nötige Minimum
    // angehoben, statt das nachträglich per Stunden-Umverteilung zu
    // korrigieren (was bei knappem Budget nicht immer zuverlässig
    // funktioniert). Nach oben begrenzt durch das, was selbst mit der
    // niedrigsten zulässigen Tagesmindestzeit (3,5 Std.) noch rechnerisch
    // möglich ist, damit kein Stundenüberschuss entsteht.
    // Das Ziel "wenige freie Tage" gilt nur für Vollzeitbeschäftigte
    // (> 129 Std./Monat) - bei Teilzeit/Minijob soll die Tagesanzahl
    // ausschließlich aus der Stundenzahl folgen (avgNetEstimate), nicht
    // künstlich aufgebläht werden, nur um wenige freie Tage zu erzwingen.
    const minRestDaysForFreeTarget = target.totalHours > 129
      ? Math.max(0, allDays.length - targetFreeDaysFloor - chosenSundays.length)
      : 0
    const maxFeasibleRestDays = restPool.length > 0 ? Math.floor(remainingHours / 3.5) : 0
    const numRestShifts = Math.min(restPool.length, Math.max(avgNetEstimate, Math.min(minRestDaysForFreeTarget, maxFeasibleRestDays)))
    restDayCountWasExpandedForFreeTarget = numRestShifts > avgNetEstimate
    // Ab 150 Std. Gesamtstunden/Monat: Arbeitstage in Blöcken von 3-5
    // aufeinanderfolgenden Tagen vergeben statt einzeln verstreut - deutlich
    // alltagstauglicher bei so hohem Stundenvolumen. Darunter: wochenweise
    // variierende Tagesanzahl (1-6 Tage/Woche, gewichtet auf 2-5) für ein
    // realistischeres, nicht-uniformes Muster.
    const chosenRestDays = target.totalHours >= 150
      ? pickBlockDays(restPool, numRestShifts)
      : pickDaysWithWeeklyVariation(restPool, numRestShifts)
    chosenWeekdays = [...chosenSundays, ...chosenRestDays]
      .sort((a, b) => a.getTime() - b.getTime())
    const chosenSet = new Set(chosenWeekdays.map(toDateStr))
    reservePool = restPool.filter((d) => !chosenSet.has(toDateStr(d)))
  }

  if (isEinzelfahrer) {
  // Arbeitstage-Auswahl nach Lücken von 3+ aufeinanderfolgenden
  // Kalendertagen ohne Schicht durchsuchen und den mittleren Tag jeder
  // gefundenen Lücke zusätzlich als Arbeitstag aufnehmen. ----
  {
    const workingDateStrs = new Set(chosenWeekdays.map(toDateStr))
    let gapStart: Date | null = null
    const extraDays: Date[] = []
    for (let i = 0; i <= allDays.length; i++) {
      const isGapDay = i < allDays.length && !workingDateStrs.has(toDateStr(allDays[i]))
      if (isGapDay) {
        if (!gapStart) gapStart = allDays[i]
      } else if (gapStart) {
        const gapEndIdx = i - 1
        const gapStartIdx = allDays.findIndex((d) => d.getTime() === gapStart!.getTime())
        const gapLength = gapEndIdx - gapStartIdx + 1
        if (gapLength >= 3) {
          const midIdx = gapStartIdx + Math.floor(gapLength / 2)
          extraDays.push(allDays[midIdx])
        }
        gapStart = null
      }
    }
    // Nur so viele Lücken-Zusatztage aufnehmen, wie das Restbudget
    // überhaupt noch trägt (mindestens BASE_MIN_NET Std. je Zusatztag) -
    // sonst würde die Lückenfüllung bei knappem Stundenziel (z. B. 100 Std.
    // nach Abzug des Pflicht-Wochenendes) mehr Tage erzwingen, als das Ziel
    // überhaupt hergibt, und die Monatssumme unnötig sprengen.
    const alreadyPlannedMinimum = numWeekdayShifts * BASE_MIN_NET
    const affordableExtraDays = Math.max(0, Math.floor((remainingHours - alreadyPlannedMinimum) / BASE_MIN_NET))
    extraDays.slice(0, affordableExtraDays).forEach((d) => {
      if (!chosenWeekdays.some((w) => w.getTime() === d.getTime())) chosenWeekdays.push(d)
    })
    chosenWeekdays = chosenWeekdays.sort((a, b) => a.getTime() - b.getTime())
  }
  } // Ende: nur für Einzelfahrer (isEinzelfahrer)

  // ---- Nie mehr als 6 Tage am Stück arbeiten (§ 11 ArbZG: nach spätestens
  // 6 aufeinanderfolgenden Arbeitstagen muss ein freier Tag folgen). Gilt
  // für beide Fahrertypen. Wird NACH der kompletten Tagesauswahl (inkl.
  // Pflicht-Wochenende und Lückenfüllung) geprüft: bei einer zu langen
  // Kette wird bevorzugt ein Montag-Donnerstag-Tag aus der Mitte der Kette
  // herausgenommen (nicht Fr/Sa/So, die als Pflicht gelten), damit die
  // Kette in Blöcke von maximal 6 Tagen aufgeteilt wird. ----
  {
    const workingSet = new Set(chosenWeekdays.map(toDateStr))
    const toRemove = new Set<string>()
    let run: Date[] = []
    for (const day of allDays) {
      const key = toDateStr(day)
      if (workingSet.has(key) && !toRemove.has(key)) {
        run.push(day)
        if (run.length > 6) {
          // Bevorzugt einen Mo-Do-Tag aus der Kette entfernen (nicht
          // Fr/Sa/So, die als Pflicht gelten) - der Tag NACH dem entfernten
          // bleibt für die weitere Zählung relevant, die Tage DAVOR waren
          // bereits innerhalb der 6er-Grenze und sind nicht mehr betroffen.
          const nonWeekendInRun = run.filter((d) => ![0, 5, 6].includes(d.getDay()))
          const dayToRemove = nonWeekendInRun.length > 0
            ? nonWeekendInRun[nonWeekendInRun.length - 1]
            : run[run.length - 1] // Notfall: sollte praktisch nie vorkommen
          toRemove.add(toDateStr(dayToRemove))
          const idx = run.findIndex((d) => toDateStr(d) === toDateStr(dayToRemove))
          run = run.slice(idx + 1)
        }
      } else {
        run = []
      }
    }
    if (toRemove.size > 0) {
      chosenWeekdays = chosenWeekdays.filter((d) => !toRemove.has(toDateStr(d)))
      warnings.push(`${toRemove.size} Tag(e) zusätzlich freigegeben, um die gesetzliche Obergrenze von 6 aufeinanderfolgenden Arbeitstagen einzuhalten.`)
    }
  }

  // ---- Schritt 1: Pro gewähltem Tag zuerst die PAUSE bestimmen (hängt nur
  // vom Wochentag/Nachfrageprofil ab, nicht von der genauen Nettozeit),
  // daraus die tagesindividuelle 10h-Obergrenze für die Nettoarbeitszeit
  // ableiten. An Freitagen/Samstagen zusätzlich eine Mindest-BRUTTO-
  // arbeitszeit (Netto + Pause) von 6 Std. sicherstellen, auch wenn die
  // Nettoarbeitszeit dabei durchaus unter 8 Std. bleiben darf. ----
  const MIN_GROSS_FRI_SAT_MINUTES = 6 * 60
  function buildContext(day: Date): DayContext {
    const weekday = day.getDay()
    const legalMinBreak = Math.max(BUSINESS_MIN_BREAK, requiredBreakMinutes(BASE_MIN_NET))
    // Zufällige Pausenlänge zwischen gesetzlichem Minimum und 120 Minuten
    // (in 15-Min.-Schritten), statt immer exakt am Minimum zu bleiben -
    // sorgt für realistischere, nicht jeden Tag identische Pausenzeiten.
    // Eine explizite Vorgabe (breakMinutesOverride) hat weiterhin Vorrang.
    const randomBreakSteps = Math.floor((120 - legalMinBreak) / 15)
    const randomBreak = legalMinBreak + Math.floor(Math.random() * (randomBreakSteps + 1)) * 15
    let breakMinutes = target.breakMinutesOverride != null ? Math.max(target.breakMinutesOverride, legalMinBreak) : randomBreak

    const lowestWindow = target.prioritizeDemand && !target.maximizeNight
      ? pickLowestDemandWindow(weekday, demandProfiles)
      : null
    if (lowestWindow) breakMinutes = Math.max(breakMinutes, Math.min(120, lowestWindow.durationMinutes))

    const maxNetMinutes = Math.max(BASE_MIN_NET * 60, TARGET_TOTAL_MAX * 60 - breakMinutes - commuteMinutes)

    // Mindest-Nettozeit bewusst NICHT künstlich angehoben, um die 8h-Regel
    // "vorsorglich" zu erreichen - das hat sich als Bumerang erwiesen: bei
    // vielen Pflichttagen (Fr/Sa/So-Vorlage) und wenig Restbudget zwingt
    // eine hohe Mindestzeit die Monatssumme über das Ziel hinaus. Die
    // exakte Monatssumme hat Vorrang; die 8h-Regel wird stattdessen
    // bestmöglich über die Pausen-Erhöhung nachgeholt (siehe Schritt 3) -
    // in seltenen Fällen (sehr geringe Nettozeit an einem Tag) reicht auch
    // die maximale Pause nicht ganz für exakt 8 Std., das wird dann
    // bewusst in Kauf genommen statt die Stundensumme zu sprengen.
    const minNetForEightHours = BASE_MIN_NET * 60
    const minNetMinutes = (isEinzelfahrer && (weekday === 5 || weekday === 6))
      ? Math.max(minNetForEightHours, MIN_GROSS_FRI_SAT_MINUTES - breakMinutes)
      : minNetForEightHours
    return { date: day, dateStr: toDateStr(day), weekday, breakMinutes, lowestWindow, maxNetMinutes, minNetMinutes }
  }

  const weekdayContexts = chosenWeekdays.map(buildContext)

  // ---- Schritt 2: Stunden verteilen (nur Montag-Donnerstag - Fr/Sa/So
  // haben feste Werte aus der Wochenend-Vorlage, siehe Schritt 3). Reicht
  // das Budget mit den bisher gewählten Tagen nicht aus (z. B. weil ein Tag
  // rechnerisch mehr als die zulässigen ~8 Std. netto bräuchte), werden
  // automatisch weitere Tage aus dem Reserve-Pool hinzugenommen, bis die
  // Reststunden untergebracht sind oder keine Tage mehr übrig sind - statt
  // die überzähligen Stunden einfach wegzulassen. Praktisch entspricht das
  // z. B. 10 Netto-Std. auf zwei Tage aufzuteilen, statt sie an einem Tag
  // unterbringen zu wollen. ----
  let distributableWeekdayContexts = isEinzelfahrer
    ? weekdayContexts.filter((c) => ![0, 5, 6].includes(c.weekday)) // Fr/Sa/So haben feste Werte
    : minijobSundayHoursByDate
      ? weekdayContexts.filter((c) => !minijobSundayHoursByDate!.has(c.dateStr)) // Sonntage haben eigene Zuteilung (siehe unten)
      : weekdayContexts
  let reserveContexts = reservePool.map(buildContext)

  // Wurde die Tagesanzahl oben erzwungen ausgeweitet (mehr Tage als die
  // Durchschnittsschätzung, um das Freie-Tage-Ziel direkt zu erreichen),
  // muss die Mindest-Nettozeit pro Tag entsprechend abgesenkt werden (bis
  // 3,5 Std.), sonst könnte die Verteilung die dünneren Stunden pro Tag
  // nicht sauber unterbringen.
  if (restDayCountWasExpandedForFreeTarget) {
    const lowerFloorMinutes = 3.5 * 60
    ;[...distributableWeekdayContexts, ...reserveContexts].forEach((c) => {
      c.minNetMinutes = Math.min(c.minNetMinutes, lowerFloorMinutes)
    })
  }
  let spesenUnrestrictedDates: Set<string> | null = null

  // Spesen-Tage-Ziel STRUKTURELL durchsetzen: nur so viele Tage wie nötig
  // dürfen überhaupt bis zur 8-Std.-Grenze gehen (niedriger gedeckelte
  // Tage für den Rest). WICHTIG: die exakte Monatsstundensumme hat Vorrang
  // vor der exakten Spesen-Tage-Zahl - die "freigegebenen" Tage bleiben
  // Teil der normalen Verteilung (nur mit höherer Ober- und Untergrenze),
  // damit die Gesamtsumme in jedem Fall stimmt, auch wenn die Spesen-Tage-
  // Zahl dadurch nur angenähert statt exakt getroffen wird.
  if (target.spesenDaysTarget && target.spesenDaysTarget > 0) {
    const qualifyThresholdMinutes = TARGET_TOTAL_MIN * 60 - BUSINESS_MIN_BREAK - commuteMinutes
    const alreadyQualifyingElsewhere = isEinzelfahrer
      ? 0
      : Array.from(minijobSundayHoursByDate?.values() ?? []).filter((h) => h * 60 >= qualifyThresholdMinutes).length
    const maxQualifyingDays = Math.max(0, Math.round(target.spesenDaysTarget) - alreadyQualifyingElsewhere)
    const allCandidates = [...distributableWeekdayContexts, ...reserveContexts]
    const shuffled = [...allCandidates].sort(() => Math.random() - 0.5)
    const unrestrictedSet = new Set(shuffled.slice(0, maxQualifyingDays).map((c) => c.dateStr))
    spesenUnrestrictedDates = unrestrictedSet
    const safeMaxNetMinutes = Math.max(BASE_MIN_NET * 60, qualifyThresholdMinutes - 15)
    const minNeededForBump = Math.max(BASE_MIN_NET * 60, TARGET_TOTAL_MIN * 60 - MAX_BREAK_STEP_MINUTES - commuteMinutes)
    allCandidates.forEach((c) => {
      if (!unrestrictedSet.has(c.dateStr)) {
        c.maxNetMinutes = Math.min(c.maxNetMinutes, safeMaxNetMinutes)
      } else {
        c.minNetMinutes = Math.max(c.minNetMinutes, minNeededForBump)
      }
    })
  }

  let hoursByDate: Map<string, number>
  let weekdayShortfall: number
  {
    const result = distributeHoursWithPerDayCap(distributableWeekdayContexts, remainingHours)
    hoursByDate = result.hoursByDate
    weekdayShortfall = result.shortfallHours

    let guard = 0
    while (weekdayShortfall > 0.1 && reserveContexts.length > 0 && guard < 10) {
      guard++
      const extra = reserveContexts.shift()!
      distributableWeekdayContexts = [...distributableWeekdayContexts, extra]
      weekdayContexts.push(extra)
      chosenWeekdays.push(extra.date)
      const retry = distributeHoursWithPerDayCap(distributableWeekdayContexts, remainingHours)
      hoursByDate = retry.hoursByDate
      weekdayShortfall = retry.shortfallHours
    }
  }

  if (weekdayShortfall > 0.2) {
    warnings.push(`${weekdayShortfall.toFixed(2)} Werktagsstunden konnten wegen der 10-Std.-Gesamtzeit-Obergrenze nicht untergebracht werden.`)
  }

  if (minijobSundayHoursByDate) {
    minijobSundayHoursByDate.forEach((h, dateStr) => hoursByDate.set(dateStr, h))
  }

  const allContexts = weekdayContexts.sort((a, b) => a.date.getTime() - b.date.getTime())

  // ---- Schritt 3: Für jeden Tag (in chronologischer Reihenfolge, wegen
  // der Ruhezeit-Kette) Start, Ende und Pausenposition festlegen. ----
  const shifts: HoursShift[] = []
  let prevEnd: Date | null = null

  // Feste Wochenend-Vorlage: Freitag, Samstag und Sonntag bekommen IMMER
  // exakt diese Zeiten (auf Nutzerwunsch fest hinterlegt, statt vom
  // allgemeinen Bewertungsalgorithmus - der lieferte trotz mehrfacher
  // Nachjustierung keine zuverlässig reproduzierbaren Werte). Ergebnis
  // exakt wie vorgegeben: Fr 7,5 Std. netto, Sa 6,5 Std. netto, So 8 Std.
  // netto - Pause jeweils 30 Minuten an der angegebenen Stelle. Sonntag
  // (sundayDedicatedNetHours) wurde bereits weiter oben berechnet.
  const FIXED_WEEKEND_TEMPLATE: Record<number, { startMin: number; spanMinutes: number; breakStart: number; breakEnd: number }> = {
    5: { startMin: 21 * 60, spanMinutes: 8 * 60, breakStart: 150, breakEnd: 180 }, // Fr 21:00-05:00, Pause 23:30-00:00
    6: { startMin: 22 * 60, spanMinutes: 7 * 60, breakStart: 90, breakEnd: 150 } // Sa 22:00-05:00, Pause 23:30-00:30 (60 Min.)
  }

  // Optionales Spesen-Euro-Ziel: begrenzt, wie viele Tage insgesamt auf die
  // 8-Std.-Gesamtzeit-Grenze angehoben werden (14 €/Tag Pauschale). Ohne
  // gesetztes Ziel (0 oder nicht angegeben) bleibt das Verhalten wie bisher
  // unbegrenzt (alle in Frage kommenden Tage werden angehoben).
  let spesenDaysRemaining = target.spesenDaysTarget && target.spesenDaysTarget > 0
    ? Math.round(target.spesenDaysTarget)
    : Infinity

  allContexts.forEach((ctx) => {
    const fixed = isEinzelfahrer ? FIXED_WEEKEND_TEMPLATE[ctx.weekday] : undefined
    const isSundayFixed = isEinzelfahrer && ctx.weekday === 0

    if (fixed || isSundayFixed) {
      const startMin = isSundayFixed ? 16 * 60 : fixed!.startMin // Sonntag startet weiterhin 16:00
      let netHours = isSundayFixed ? sundayDedicatedNetHours : (fixed!.spanMinutes - (fixed!.breakEnd - fixed!.breakStart)) / 60
      const netMinutes = Math.round(netHours * 60)
      let breakMinutes = isSundayFixed ? BUSINESS_MIN_BREAK : fixed!.breakEnd - fixed!.breakStart
      const breakStartOffset = isSundayFixed ? Math.round(netMinutes / 2) : fixed!.breakStart

      // 8-Std.-Mindestgesamtzeit gilt auch hier (Vollzeit) - die feste
      // Nettozeit aus der Vorlage bleibt UNVERÄNDERT, nur die Pause wird
      // bei Bedarf stufenweise verlängert (30 -> 45 -> 60 -> 90 -> 120 Min.).
      // Zählt gegen das Spesen-Euro-Budget, falls eines gesetzt ist -
      // bereits von Natur aus 8h+ erreichende Tage verbrauchen ebenfalls
      // Budget (sie zählen ja auch als Spesen-Tag), verlängerte Pause nur
      // wenn noch Budget übrig ist.
      const alreadyQualifies = netMinutes + breakMinutes + commuteMinutes >= TARGET_TOTAL_MIN * 60
      if (alreadyQualifies) {
        spesenDaysRemaining--
      } else if (spesenDaysRemaining > 0) {
        for (const step of BREAK_STEPS) {
          if (step <= breakMinutes) continue
          breakMinutes = step
          if (netMinutes + breakMinutes + commuteMinutes >= TARGET_TOTAL_MIN * 60) break
        }
        spesenDaysRemaining--
      }

      const spanMinutes = netMinutes + breakMinutes
      const endMin = startMin + spanMinutes
      shifts.push({
        driverId: target.driverId, date: ctx.dateStr, startMin, endMin,
        breakMinutes, breaks: [{ start: breakStartOffset, end: breakStartOffset + breakMinutes }],
        netHours, commuteMinutes
      })
      prevEnd = new Date(ctx.date.getFullYear(), ctx.date.getMonth(), ctx.date.getDate(), 0, endMin, 0, 0)
      return
    }

    const netHours = hoursByDate.get(ctx.dateStr) ?? BASE_MIN_NET
    const netMinutes = Math.round(netHours * 60)

    // Vollzeit-Erkennung: bei aktivierter Spesen-Berechnung ODER ab 100
    // Netto-Std./Monat MUSS die Gesamtzeit (Netto + Pause + Arbeitsweg)
    // mindestens 8 Std. betragen (Voraussetzung für Verpflegungsmehr-
    // aufwand). Reicht die Nettoarbeitszeit dafür allein nicht aus, wird
    // die Pause stufenweise erhöht (30 -> 45 -> 60 -> 90 -> 120 Minuten) -
    // rechtlich zulässig, da das ArbZG nur eine Mindestpause vorschreibt,
    // keine Höchstdauer. Die Pause wird NIE verringert, nur bei Bedarf
    // angehoben. Begrenzt durch das Spesen-Euro-Budget, falls gesetzt.
    const mustReachEightHours = target.calculateExpenses
    const spesenBudgetActive = target.spesenDaysTarget != null && target.spesenDaysTarget > 0
    let currentlyQualifies = netMinutes + ctx.breakMinutes + commuteMinutes >= TARGET_TOTAL_MIN * 60

    if (mustReachEightHours && currentlyQualifies && spesenBudgetActive && spesenDaysRemaining <= 0) {
      // Budget ist aufgebraucht, der Tag qualifiziert sich aber trotzdem
      // (z. B. weil die Pause durch die Nachfrage-Priorisierung ohnehin
      // schon länger war) - Pause auf das gesetzliche Minimum zurücksetzen
      // und prüfen, ob der Tag dadurch unter die 8h-Grenze rutscht (spart
      // dann echtes Spesen-Budget). Hilft nicht, wenn bereits die reine
      // Nettoarbeitszeit allein die 8h-Grenze überschreitet.
      const legalMin = Math.max(BUSINESS_MIN_BREAK, requiredBreakMinutes(netHours))
      if (legalMin < ctx.breakMinutes) {
        ctx.breakMinutes = legalMin
        currentlyQualifies = netMinutes + ctx.breakMinutes + commuteMinutes >= TARGET_TOTAL_MIN * 60
      }
    }

    if (mustReachEightHours && currentlyQualifies) {
      spesenDaysRemaining--
    } else if (mustReachEightHours && !currentlyQualifies && spesenDaysRemaining > 0 && (!spesenBudgetActive || spesenUnrestrictedDates?.has(ctx.dateStr))) {
      // Nachträgliches Hochstufen: ohne Spesen-Budget wie bisher für jeden
      // in Frage kommenden Tag; MIT Spesen-Budget nur für die vorab dafür
      // "freigegebenen" Tage (sonst würde das die vorab vorgenommene
      // Deckelung der übrigen Tage wieder aushebeln).
      for (const step of BREAK_STEPS) {
        if (step <= ctx.breakMinutes) continue
        ctx.breakMinutes = step
        const total = netMinutes + ctx.breakMinutes + commuteMinutes
        if (total >= TARGET_TOTAL_MIN * 60 || total > TARGET_TOTAL_MAX * 60) break
      }
      spesenDaysRemaining--
    }

    const spanMinutes = netMinutes + ctx.breakMinutes

    let startMin: number
    let breaks: { start: number; end: number }[]

    if (ctx.lowestWindow) {
      const workBeforeBreak = Math.round(netMinutes / 2)
      let breakStartAbs = ctx.lowestWindow.startMinOfDay
      let candidateStart = breakStartAbs - workBeforeBreak
      while (prevEnd) {
        const candDate = new Date(ctx.date.getFullYear(), ctx.date.getMonth(), ctx.date.getDate(), 0, candidateStart, 0, 0)
        if ((candDate.getTime() - prevEnd.getTime()) / 3600000 >= minRestHours) break
        candidateStart += 15
        breakStartAbs += 15
      }
      startMin = candidateStart
      const breakRelStart = breakStartAbs - startMin
      breaks = [{ start: breakRelStart, end: breakRelStart + ctx.breakMinutes }]
    } else {
      const randomPreferredStart = 5 * 60 + Math.floor(Math.random() * 4 * 60) // 05:00-09:00, zufällig

      // Samstagsschichten dürfen NICHT in den Sonntag hineinreichen, wenn
      // bereits eine eigene Sonntagsstunden-Menge vorgegeben ist (target.
      // sundayHours > 0) - sonst würde die Gesamt-Sonntagszuschlagszeit
      // über den vom Nutzer festgelegten Wert hinausgehen (dedizierte
      // Sonntagsschichten + Samstags-Überlauf zusammengerechnet). Der
      // eingegebene Wert ist eine harte Obergrenze, keine Zielgröße.
      const mustStayInDay = ctx.weekday === 6 && target.sundayHours > 0
      const searchLatest = mustStayInDay ? Math.max(0, 1440 - spanMinutes) : START_WINDOW.latest

      let bestStart = START_WINDOW.earliest
      let bestScore = -Infinity
      for (let cand = START_WINDOW.earliest; cand <= searchLatest; cand += 15) {
        const candStart = new Date(ctx.date.getFullYear(), ctx.date.getMonth(), ctx.date.getDate(), 0, cand, 0, 0)
        if (prevEnd && (candStart.getTime() - prevEnd.getTime()) / 3600000 < minRestHours) continue
        const baseScore = target.maximizeNight
          // Echter Zuschlagswert (Sonntag 50 % + steuerfreie Nacht 40 % +
          // reguläre Nacht 25 %), optional zusätzlich leicht durch die
          // Nachfrage beeinflusst ("Nachfrage in der Großstadt
          // berücksichtigen") - lässt aufeinanderfolgende Tage natürlich
          // gegeneinander abwägen (z. B. Samstagschicht, die bewusst in
          // den Sonntagmorgen hineinreicht).
          ? surchargeValueScore(cand, cand + spanMinutes, ctx.weekday) +
            (target.prioritizeDemand ? 0.3 * demandScore(cand, cand + spanMinutes, ctx.weekday, demandProfiles) : 0) +
            Math.random() * 8 // kleine Streuung, damit nicht jeden Tag exakt dieselbe Uhrzeit rauskommt
          : target.prioritizeDemand
            // Auch OHNE explizit gesetztes "Nachtzuschläge maximieren"
            // soll die Nachfrage-Priorisierung Zuschläge nicht komplett
            // ignorieren - Nachfrage bleibt das Hauptkriterium, Zuschlagswert
            // wirkt als zweites, schwächer gewichtetes Kriterium mit.
            ? demandScore(cand, cand + spanMinutes, ctx.weekday, demandProfiles) +
              0.3 * surchargeValueScore(cand, cand + spanMinutes, ctx.weekday) +
              Math.random() * 8
            : -Math.abs(cand - randomPreferredStart) + Math.random() * 5

        // "Sonntagszuschlag priorisieren" wirkt als eigenständiger,
        // zusätzlicher Bonus - unabhängig davon, ob Nachtzuschlag oder
        // Nachfrage aktiv sind. Wird stark gewichtet, damit er bei
        // Gleichstand/knappen Entscheidungen den Ausschlag gibt, bleibt
        // aber durch die searchLatest-Deckelung oben (bei Samstagen mit
        // eigener Sonntagsstunden-Vorgabe) innerhalb der harten
        // Obergrenze - er kann sie also nicht überschreiten, nur die
        // verfügbaren Sonntagsminuten innerhalb dieser Grenze bestmöglich
        // ausnutzen.
        const sundayBonus = target.prioritizeSunday
          ? sundayOverlapMinutes(cand, cand + spanMinutes, ctx.weekday) * 0.5
          : 0

        const score = baseScore + sundayBonus
        if (score > bestScore) { bestScore = score; bestStart = cand }
      }
      startMin = bestStart

      if (target.maximizeNight || target.prioritizeDemand) {
        // Pause WERTSENSITIV platzieren: unter allen zulässigen Positionen
        // (2-6 Std. nach Schichtbeginn, wie gesetzlich üblich) diejenige
        // wählen, die den GERINGSTEN Zuschlagswert verliert - z. B. eine
        // Pause lieber in eine normale Abendstunde legen als mitten in die
        // steuerfreien 00-04-Uhr- oder Sonntagsstunden.
        const earliestOffset = 120
        const latestOffset = Math.min(360, spanMinutes - ctx.breakMinutes)
        let bestBreakStart = Math.min(earliestOffset, Math.max(0, spanMinutes - ctx.breakMinutes))
        let bestBreakLoss = Infinity
        for (let off = Math.min(earliestOffset, latestOffset); off <= latestOffset; off += 15) {
          const bStart = startMin + off
          const bEnd = bStart + ctx.breakMinutes
          const loss = surchargeValueScore(bStart, bEnd, ctx.weekday)
          if (loss < bestBreakLoss) { bestBreakLoss = loss; bestBreakStart = off }
        }
        breaks = [{ start: bestBreakStart, end: bestBreakStart + ctx.breakMinutes }]
      } else {
        breaks = positionBreak(spanMinutes, ctx.breakMinutes)
      }
    }

    const endMin = startMin + spanMinutes

    shifts.push({ driverId: target.driverId, date: ctx.dateStr, startMin, endMin, breakMinutes: ctx.breakMinutes, breaks, netHours, commuteMinutes })
    prevEnd = new Date(ctx.date.getFullYear(), ctx.date.getMonth(), ctx.date.getDate(), 0, endMin, 0, 0)
  })

  const deliveredTotal = shifts.reduce((s, x) => s + x.netHours, 0)
  if (deliveredTotal > target.totalHours + 0.5) {
    warnings.push(`Monatssumme liegt bei ${deliveredTotal.toFixed(2)} Std. statt der eingegebenen ${target.totalHours} Std. - das kommt durch die feste 8-Std.-Mindestgesamtzeit pro Tag (Vollzeit) in Kombination mit Pflichttagen (Fr/Sa, "nie 3 Tage frei") zustande, die zusammen mehr Tage als ursprünglich geschätzt benötigen.`)
  }

  // ---- Freie Tage auf 4-7 pro Monat begrenzen ----
  // Gilt NUR für Vollzeitbeschäftigte (> 129 Std./Monat) - bei Teilzeit/
  // Minijob ist eine hohe Zahl freier Tage normal und soll nicht künstlich
  // durch zusätzliche, dünn belegte Arbeitstage "korrigiert" werden.
  //
  // Sind es mehr als 7 freie Tage (weil die vorhandenen Schichten die
  // übrigen Tage nicht "sättigen"), wird schrittweise Nettoarbeitszeit von
  // Tagen OHNE Spesen-Berechtigung (< 8h Brutto) in 30-Min.-Schritten
  // abgezogen und aufgesammelt, bis genug für eine komplett neue
  // Tagesschicht zusammenkommt - die dann auf einem der freien Tage
  // platziert wird. Die Monatsgesamtsumme bleibt dabei unverändert, es
  // werden nur Stunden zwischen Tagen umverteilt. Reicht die normale
  // Mindestschichtgröße (5 Std.) nicht aus, um genug neue Tage zu schaffen,
  // wird die Mindestgröße für NEUE Tage schrittweise gesenkt (5 -> 4 ->
  // 3,5 Std.), damit das Ziel möglichst dennoch erreicht wird.
  if (target.totalHours > 129) {
    const MAX_FREE_DAYS = 7
    const TARGET_FREE_DAYS = targetFreeDaysFloor // Priorität: möglichst im gewünschten Zielbereich landen, nicht nur irgendwo unter 7
    const MIN_SHIFT_FLOOR_CANDIDATES = [BASE_MIN_NET, 4, 3.5] // Std., der Reihe nach versucht
    // NICHT der komplette Kalendermonat, sondern nur die für diesen Fahrer
    // überhaupt zulässigen Tage (ab Eintrittsdatum) - sonst könnten hier
    // Tage vor dem Eintritt mit einer Schicht "aufgefüllt" werden.
    const monthDays = allDays

    function freeDates(): Date[] {
      const workingDateStrs = new Set(shifts.map((s) => s.date))
      return monthDays.filter((d) => !workingDateStrs.has(toDateStr(d)))
    }

    for (const floorHours of MIN_SHIFT_FLOOR_CANDIDATES) {
      const floorMinutes = floorHours * 60
      let guard = 0
      while (freeDates().length > TARGET_FREE_DAYS && guard < 50) {
        guard++
        const grossHours = (s: HoursShift) => s.netHours + s.breakMinutes / 60 + s.commuteMinutes / 60

        // Spender: Tage ohne (beabsichtigte) Spesen-Berechtigung, mit genug
        // Netto-Puffer (bleiben nach Abzug mindestens bei der aktuellen
        // Mindestgröße). Der Brutto-Check (< 8h) greift nur, wenn für
        // diesen Fahrer überhaupt Spesen vorgesehen sind
        // (calculateExpenses/spesenDaysTarget) - sonst zählt eine zufällig
        // lange Pause nicht als "Spesen-Tag" und der Tag bleibt trotzdem
        // als Spender nutzbar.
        const spesenRelevant = target.calculateExpenses || (target.spesenDaysTarget != null && target.spesenDaysTarget > 0)
        const donors = shifts
          .filter((s) => (!spesenRelevant || grossHours(s) < 7.99) && s.netHours > floorHours + 0.5)
          .sort((a, b) => b.netHours - a.netHours)
        if (donors.length === 0) break // keine Spender auf dieser Stufe mehr verfügbar - nächste (niedrigere) Stufe versuchen

        const neededMinutes = floorMinutes
        let accumulated = 0
        const reductions: { shift: HoursShift; amountMinutes: number }[] = []
        for (const donor of donors) {
          if (accumulated >= neededMinutes) break
          // Die Kürzung darf nicht in die Pause hineinreichen - sonst
          // stimmen die (angezeigten) Uhrzeiten nicht mehr mit der
          // gekürzten Nettozeit überein.
          const lastBreakEnd = donor.breaks.length > 0 ? donor.breaks[donor.breaks.length - 1].end : 0
          const spareAfterBreak = Math.max(0, (donor.endMin - donor.startMin) - lastBreakEnd)
          const maxReducibleMinutes = Math.min(
            Math.floor((donor.netHours * 60 - floorMinutes) / 30) * 30,
            Math.floor(spareAfterBreak / 30) * 30
          )
          const take = Math.min(maxReducibleMinutes, neededMinutes - accumulated)
          if (take <= 0) continue
          donor.netHours = Math.round((donor.netHours - take / 60) * 100) / 100
          // Uhrzeiten (endMin) MÜSSEN mit der reduzierten Nettozeit Schritt
          // halten - sonst zeigen Vorschau/PDF/Zuschlagsberechnung (die aus
          // startMin/endMin/breakMinutes ableiten, nicht aus netHours) nach
          // wie vor die ungekürzte, längere Schicht an und die Monatssumme
          // läuft der eingegebenen Stundenzahl davon.
          donor.endMin -= take
          accumulated += take
          reductions.push({ shift: donor, amountMinutes: take })
        }

        if (accumulated < neededMinutes) {
          // Nicht genug Puffer auf dieser Stufe zusammenbekommen - ALLE
          // bereits getätigten Kürzungen exakt rückgängig machen, damit
          // keine Nettostunden verloren gehen, und die nächste (niedrigere)
          // Mindestgröße versuchen.
          reductions.forEach(({ shift, amountMinutes }) => {
            shift.netHours = Math.round((shift.netHours + amountMinutes / 60) * 100) / 100
            shift.endMin += amountMinutes
          })
          break
        }

        // Neue Schicht auf einem freien Tag anlegen (Rand-vor-Mitte-Prinzip
        // für die Auswahl, konsistent mit der übrigen Tagesauswahl-Logik) -
        // dabei Tage ausschließen, die eine Kette von mehr als 6
        // aufeinanderfolgenden Arbeitstagen erzeugen würden (gesetzliche
        // Obergrenze, ArbZG).
        const workingDateStrsForCheck = new Set(shifts.map((s) => s.date))
        function wouldExceedSixConsecutive(d: Date): boolean {
          const ds = toDateStr(d)
          let runLength = 1
          const cursor = new Date(d)
          for (let i = 0; i < 6; i++) {
            cursor.setDate(cursor.getDate() - 1)
            if (workingDateStrsForCheck.has(toDateStr(cursor))) runLength++
            else break
          }
          const cursor2 = new Date(d)
          for (let i = 0; i < 6; i++) {
            cursor2.setDate(cursor2.getDate() + 1)
            if (workingDateStrsForCheck.has(toDateStr(cursor2))) runLength++
            else break
          }
          return runLength > 6
        }
        const candidates = freeDates().filter((d) => !wouldExceedSixConsecutive(d))
        if (candidates.length === 0) break
        const [newDay] = pickDaysEdgeFirst(candidates, 1)
        const newCtx = buildContext(newDay)
        const netHours = accumulated / 60
        const netMinutes = accumulated
        const spanMinutes = netMinutes + newCtx.breakMinutes
        const startMin = 6 * 60 + Math.floor(Math.random() * 4 * 60) // 06:00-10:00, zufällig
        const endMin = startMin + spanMinutes
        const newBreaks = positionBreak(spanMinutes, newCtx.breakMinutes)

        shifts.push({
          driverId: target.driverId, date: toDateStr(newDay), startMin, endMin,
          breakMinutes: newCtx.breakMinutes, breaks: newBreaks, netHours, commuteMinutes
        })
      }
      if (freeDates().length <= TARGET_FREE_DAYS) break // Ziel erreicht, weitere Stufen nicht mehr nötig
    }

    if (freeDates().length > MAX_FREE_DAYS) {
      warnings.push(`Freie Tage (${freeDates().length}) konnten nicht auf max. 7 gesenkt werden - selbst mit auf 3,5 Std. abgesenkter Mindestschichtgröße reicht die Gesamtstundenzahl dafür nicht aus.`)
    }
  }

  // ---- Spesen-Tage-Ziel iterativ nachschärfen ----
  // Verändert AUSSCHLIESSLICH Pausenlängen (in 15-Min.-Schritten) an
  // einzelnen Tagen - die Nettoarbeitszeit und damit die Monatssumme
  // bleiben dabei garantiert unverändert. Läuft so lange, bis die Anzahl
  // der Tage mit >= 8 Std. Gesamtzeit exakt der Vorgabe entspricht (oder
  // keine weitere Verbesserung mehr möglich ist).
  if (target.spesenDaysTarget && target.spesenDaysTarget > 0) {
    const targetDays = Math.round(target.spesenDaysTarget)
    const grossHours = (s: HoursShift) => s.netHours + s.breakMinutes / 60 + s.commuteMinutes / 60
    const countQualifying = () => shifts.filter((s) => grossHours(s) >= 7.99).length

    let guard = 0
    while (guard < 300) {
      guard++
      const current = countQualifying()
      if (current === targetDays) break

      if (current < targetDays) {
        // Zu wenige Spesen-Tage: den Tag, der der 8h-Grenze am nächsten
        // ist (aber noch drunter liegt), per 15-Min.-Pausenverlängerung
        // darüber schieben - nur wenn dabei die 10h-Gesamtzeit-Obergrenze
        // nicht überschritten wird und die Pause nicht schon bei 120 Min.
        // (gesetzliche Praxisgrenze) angekommen ist.
        const candidates = shifts
          .filter((s) => grossHours(s) < 7.99 && s.breakMinutes < 120 && grossHours(s) + 0.25 <= TARGET_TOTAL_MAX + 0.001)
          .sort((a, b) => grossHours(b) - grossHours(a))
        if (candidates.length === 0) break // keine weitere Verbesserung möglich
        const s = candidates[0]
        s.breakMinutes += 15
        s.breaks[s.breaks.length - 1].end += 15
        s.endMin += 15
      } else {
        // Zu viele Spesen-Tage: den qualifizierenden Tag mit der längsten
        // Pause (und, bei Gleichstand, am nächsten an der 8h-Grenze) per
        // 15-Min.-Pausenverkürzung wieder unter die Grenze bringen - nie
        // unter die gesetzliche Mindestpause (30 Min.).
        const candidates = shifts
          .filter((s) => grossHours(s) >= 7.99 && s.breakMinutes > 30)
          .sort((a, b) => (b.breakMinutes !== a.breakMinutes ? b.breakMinutes - a.breakMinutes : grossHours(a) - grossHours(b)))
        if (candidates.length === 0) break // keine weitere Verbesserung möglich
        const s = candidates[0]
        s.breakMinutes -= 15
        s.breaks[s.breaks.length - 1].end -= 15
        s.endMin -= 15
      }
    }

    const finalCount = countQualifying()
    if (finalCount !== targetDays) {
      warnings.push(`Spesen-Tage-Ziel (${targetDays}) konnte nicht exakt erreicht werden (${finalCount} Tage generiert) - vermutlich reichen die verfügbaren Tage/Pausenspielräume dafür nicht aus.`)
    }
  }

  // ---- Finale Sicherheitsprüfung: nie mehr als 6 aufeinanderfolgende
  // Arbeitstage (ArbZG) ---- Fängt jede Verletzung ab, unabhängig davon,
  // durch welchen Schritt sie entstanden ist (z. B. durch das nachträgliche
  // Auffüllen freier Tage) - der zuletzt hinzugekommene Tag einer zu langen
  // Kette wird wieder freigegeben.
  {
    let guard = 0
    while (guard < 30) {
      guard++
      const sortedShifts = [...shifts].sort((a, b) => a.date.localeCompare(b.date))
      let violationIndex = -1
      let runLength = 1
      for (let i = 1; i < sortedShifts.length; i++) {
        const prev = new Date(sortedShifts[i - 1].date)
        const curr = new Date(sortedShifts[i].date)
        prev.setDate(prev.getDate() + 1)
        if (toDateStr(prev) === sortedShifts[i].date) {
          runLength++
          if (runLength > 6) { violationIndex = i; break }
        } else {
          runLength = 1
        }
      }
      if (violationIndex === -1) break
      const violatingDate = sortedShifts[violationIndex].date
      const idx = shifts.findIndex((s) => s.date === violatingDate)
      if (idx === -1) break
      shifts.splice(idx, 1)
      warnings.push(`${violatingDate}: Schicht wieder freigegeben, um die gesetzliche Obergrenze von 6 aufeinanderfolgenden Arbeitstagen einzuhalten.`)
    }
  }

  return { shifts, warning: warnings.length > 0 ? warnings.join(' ') : null }
}

/**
 * Öffentlicher Einstiegspunkt: versucht bei gesetztem Spesen-Tage-Ziel
 * automatisch mit steigender Anzahl freier Tage (4 -> 5 -> 6 -> 7 - der bei
 * Vollzeit, > 129 Std./Monat, zulässige Gesamtbereich), falls das Ziel mit
 * weniger freien Tagen nicht erreichbar ist - mehr freie Tage bei gleicher
 * Gesamtstundenzahl bedeuten mehr Stunden pro Arbeitstag, was das Erreichen
 * der 8h-Spesen-Grenze an mehr Tagen erleichtert. Wählt das erste Ergebnis,
 * das das Spesen-Ziel exakt trifft, sonst das mit der geringsten Abweichung
 * (bei Gleichstand die mit weniger freien Tagen, da 4 näher am bevorzugten
 * Zielbereich liegt).
 */
export function generateHoursBasedSchedule(
  year: number,
  month0: number,
  target: HoursTarget,
  blockedDates: Set<string>,
  nightStart: string,
  nightEnd: string,
  minRestHours: number,
  demandProfiles: DemandProfileInput[] = []
): { shifts: HoursShift[]; warning: string | null } {
  if (!target.spesenDaysTarget || target.spesenDaysTarget <= 0) {
    return generateHoursBasedScheduleAttempt(year, month0, target, blockedDates, nightStart, nightEnd, minRestHours, demandProfiles, 5)
  }

  const spesenTarget = Math.round(target.spesenDaysTarget)
  let best: { shifts: HoursShift[]; warning: string | null } | null = null
  let bestGap = Infinity

  for (const floor of [4, 5, 6, 7]) {
    const attempt = generateHoursBasedScheduleAttempt(year, month0, target, blockedDates, nightStart, nightEnd, minRestHours, demandProfiles, floor)
    const qualifyingDays = attempt.shifts.filter((s) => s.netHours + s.breakMinutes / 60 + s.commuteMinutes / 60 >= 7.99).length
    const gap = Math.abs(qualifyingDays - spesenTarget)
    if (gap === 0) return attempt // Ziel exakt getroffen, kein weiterer Versuch nötig
    if (gap < bestGap) {
      bestGap = gap
      best = attempt
    }
  }

  return best ?? generateHoursBasedScheduleAttempt(year, month0, target, blockedDates, nightStart, nightEnd, minRestHours, demandProfiles, 5)
}

const LEVEL_WEIGHT_FOR_BREAK: Record<string, number> = { niedrig: 0.5, mittel: 1, hoch: 1.5, sehr_hoch: 2 }

/** Findet das Nachfragefenster mit der niedrigsten Stufe für einen Wochentag (für die Pausenplatzierung). */
function pickLowestDemandWindow(
  weekday: number,
  demandProfiles: DemandProfileInput[]
): { startMinOfDay: number; durationMinutes: number } | null {
  function timeToMin(t: string): number {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }

  // Auf eine "erweiterte Woche" (Minuten seit Montag 00:00) normalisieren,
  // damit Fenster über Mitternacht/Wochenwechsel hinweg korrekt behandelt
  // werden können.
  const toMondayIdx = (dow: number) => (dow === 0 ? 6 : dow - 1)
  type Seg = { start: number; end: number; level: string }
  const segments: Seg[] = []
  demandProfiles.forEach((p) => {
    const dayOffset = toMondayIdx(p.weekday) * 1440
    const start = dayOffset + timeToMin(p.startTime)
    let end = dayOffset + timeToMin(p.endTime)
    if (end <= start) end += 1440
    segments.push({ start, end, level: p.level })
  })
  segments.sort((a, b) => a.start - b.start)
  if (segments.length === 0) return null

  const lowestLevel = segments.reduce(
    (min, s) => (LEVEL_WEIGHT_FOR_BREAK[s.level] < LEVEL_WEIGHT_FOR_BREAK[min] ? s.level : min),
    segments[0].level
  )

  // Benachbarte (direkt aneinandergrenzende) Segmente auf demselben
  // niedrigsten Level zu EINER durchgehenden Flaute zusammenfassen (z. B.
  // zwei "Mittel"-Blöcke hintereinander = eine lange Pausenoption, statt
  // nur den ersten kurzen Teilblock zu sehen).
  const merged: Seg[] = []
  segments.forEach((s) => {
    if (s.level !== lowestLevel) return
    const last = merged[merged.length - 1]
    if (last && last.end === s.start) last.end = s.end
    else merged.push({ ...s })
  })
  if (merged.length === 0) return null

  // Nur Flauten berücksichtigen, die den angefragten Wochentag tatsächlich
  // überschneiden (nicht irgendeinen beliebigen Tag der Woche).
  const requestedDayOffset = toMondayIdx(weekday) * 1440
  const relevant = merged.filter((s) => s.start < requestedDayOffset + 1440 && s.end > requestedDayOffset)
  if (relevant.length === 0) return null

  // Die längste zusammenhängende, relevante Flaute wählen.
  const best = relevant.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))

  // Zurück auf "Minuten seit Mitternacht DES angefragten Wochentags"
  // umrechnen (kann negativ/>1440 sein, falls die Flaute in einen
  // Nachbartag hineinreicht - das ist beabsichtigt und wird von der
  // aufrufenden Stelle über die absolute Tagesminute weiterverarbeitet).
  return { startMinOfDay: best.start - requestedDayOffset, durationMinutes: best.end - best.start }
}
