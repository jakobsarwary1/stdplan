import { requiredBreakMinutes, positionBreak, MIN_BREAK_MINUTES, MAX_BREAK_MINUTES } from './breaks'
import { demandScore, type DemandProfileInput } from './demand'

export type HoursTarget = {
  driverId: string
  driverName: string
  hireDate: string | null // "YYYY-MM-DD" - Tage davor dürfen keine Schicht erhalten (Fahrer noch nicht eingetreten)
  excludedDates: string[] // "YYYY-MM-DD" - einzelne Tage, für die explizit KEINE Schicht erzeugt werden soll (z. B. Krankheit, Urlaub)
  totalHours: number
  sundayHours: number
  nightHours: number // Ziel-Stundenzahl in der Nachtzeit (20-06 Uhr), analog zu sundayHours - bestmöglich, keine Garantie auf exaktes Treffen
  commuteMinutes: number
  breakMinutesOverride: number | null // bewusst gewählte, längere Pause (z. B. Split-Shift) - nie unter das gesetzliche Minimum
  calculateExpenses: boolean // Spesen/Verpflegungsmehraufwand berechnen - erzwingt 8-10h Gesamtzeit; sonst nur 5-8h Netto ohne Gesamtzeit-Zwang
  prioritizeDemand: boolean // Startzeit anhand der Nachfrageprofile wählen (z. B. für Einzelfahrer-Fahrzeuge)
  prioritizeSunday: boolean // Sonntagsüberlappung zusätzlich gezielt maximieren (unabhängig von Nachtzuschlag/Nachfrage), bleibt aber innerhalb der harten sundayHours-Obergrenze
  maximizeNight: boolean
  spesenDaysTarget?: number // optionale Ziel-Anzahl an Spesen-Tagen (>=8h Brutto) - direkt als Tageszahl, keine Euro-Umrechnung mehr
  maxFreeDays?: number | null // ausdrueckliche Obergrenze fuer freie Tage aus dem Formular; null = automatische Regel
  // Im Kalender bereits als "Frei" markierte Tage. Sie zaehlen gegen
  // maxFreeDays (der Planer darf entsprechend weniger zusaetzliche freie Tage
  // vergeben). Als "Beurlaubt" oder "Krankgeschrieben" markierte Tage zaehlen
  // NICHT mit - Urlaub und Krankheit sind keine freien Tage.
  preFreeDays?: number
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
const BUSINESS_MIN_BREAK = MIN_BREAK_MINUTES
const BASE_MIN_NET = 5
const BASE_MAX_NET = 8
// Ab dieser Monatsstundenzahl gilt die Obergrenze für freie Tage. Darunter
// (Teilzeit/Minijob) folgt die Tagesanzahl weiterhin allein der Stundenzahl.
const FREE_DAY_RULE_MIN_HOURS = 100
// Mehr freie Tage als das nicht – im Monat insgesamt und je Kalenderwoche.
// Notfalls werden dafür die einzelnen Tage kürzer.
const MAX_FREE_DAYS = 6
const MAX_FREE_DAYS_PER_WEEK = 2
// Kürzeste zumutbare Schicht, wenn die Tage dafür verkürzt werden müssen.
const ABS_MIN_NET = 3.5
// Feste Wochenend-Vorlage (siehe FIXED_WEEKEND_TEMPLATE weiter unten) -
// hier als Konstanten, damit die Verteilungsrechnung für Montag-Donnerstag
// diese fixen Werte korrekt vom Gesamtbudget abziehen kann.
const FRI_FIXED_NET_HOURS = 7.5
const SAT_FIXED_NET_HOURS = 6
const SUN_FIXED_NET_HOURS = 6
// Pausen-Rahmen: nie unter 30, nie ueber 120 Minuten (§ 4 ArbZG gibt nur
// das Minimum vor, die 120 Min. sind die betriebliche Obergrenze).
const BREAK_STEPS = [45, 60, 90, 120]
const MAX_BREAK_STEP_MINUTES = BREAK_STEPS[BREAK_STEPS.length - 1]
const START_WINDOW = { earliest: 4 * 60, latest: 22 * 60 } // 04:00-22:00, in 15-Minuten-Schritten durchsucht

/**
 * Belegung EINES Fahrzeugs durch bereits verplante Fahrer: je Datum die
 * Zeitfenster, in denen der Wagen unterwegs ist. Minuten ab Mitternacht des
 * jeweiligen Datums; ein Wert über 1440 bedeutet, die Schicht läuft in den
 * Folgetag (Nachtschicht 21:00-05:00 = 1260 bis 1740).
 */
export type VehicleBusy = Map<string, { start: number; end: number }[]>

/**
 * Übergabepuffer zwischen zwei Schichten desselben Fahrzeugs: eine Stunde.
 * Vorbild ist der gewünschte Zwei-Schicht-Betrieb Früh 06:00-17:00 und
 * Spät 18:00-05:00 – dazwischen liegt jeweils genau diese Stunde.
 */
const HANDOVER_MINUTES = 60

/** Datum um `delta` Tage verschieben, als "YYYY-MM-DD". */
function shiftDateStr(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * Überschneidet sich [start, end) am Tag `dateStr` mit einer bestehenden
 * Belegung des Fahrzeugs? Geprüft wird der Vortag mit (dessen Nachtschicht
 * kann hereinragen), der Tag selbst und der Folgetag (falls die eigene
 * Schicht über Mitternacht läuft). Der Übergabepuffer zählt als belegt.
 */
function vehicleConflict(busy: VehicleBusy | undefined, dateStr: string, start: number, end: number): boolean {
  if (!busy || busy.size === 0) return false
  for (const delta of [-1, 0, 1]) {
    const eintraege = busy.get(shiftDateStr(dateStr, delta))
    if (!eintraege) continue
    const versatz = delta * 1440 // Fenster des Nachbartags in unsere Zeitachse umrechnen
    for (const b of eintraege) {
      const bStart = b.start + versatz - HANDOVER_MINUTES
      const bEnd = b.end + versatz + HANDOVER_MINUTES
      if (start < bEnd && end > bStart) return true
    }
  }
  return false
}

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

/** Wie viele Minuten von [startMin, endMin) auf die Nachtzeit (20-06 Uhr, kann mehrere Tage überspannen) fallen. */
function nightOverlapMinutes(startMin: number, endMin: number): number {
  let total = 0
  let cursor = startMin
  const ov = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
  while (cursor < endMin) {
    const dayIndex = Math.floor(cursor / 1440)
    const localStart = cursor - dayIndex * 1440
    const localEnd = Math.min(endMin, (dayIndex + 1) * 1440) - dayIndex * 1440
    total += ov(localStart, localEnd, 0, 360) + ov(localStart, localEnd, 1200, 1440)
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
 * `blockedDates`: Tage, an denen das FAHRZEUG komplett ausfällt (z. B.
 * Werkstatt) - dort entsteht für niemanden eine Schicht. NICHT mehr für die
 * Belegung durch einen anderen Fahrer: die läuft über `vehicleBusy` und
 * sperrt nur die gefahrenen Zeiten, damit sich Nacht- und Tagschicht ein
 * Datum teilen können.
 *
 * Abwesenheiten eines FAHRERS (Krankheit, Urlaub) stehen dagegen in
 * `target.excludedDates` und gelten ausschließlich für ihn - der zweite
 * Fahrer desselben Fahrzeugs kann an solchen Tagen normal arbeiten.
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
  targetFreeDaysFloor: number = 5,
  vehicleBusy?: VehicleBusy
): { shifts: HoursShift[]; warning: string | null } {
  const commuteMinutes = target.commuteMinutes > 0 ? target.commuteMinutes : DEFAULT_COMMUTE_MINUTES

  const excludedDateSet = new Set(target.excludedDates ?? [])
  const allDays = daysInMonth(year, month0).filter(
    (d) => !blockedDates.has(toDateStr(d)) && !excludedDateSet.has(toDateStr(d)) && (!target.hireDate || toDateStr(d) >= target.hireDate)
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
  // Gilt die Obergrenze fuer freie Tage? Einzelfahrer sind ausgenommen: sie
  // haben feste Fr/Sa/So-Stunden und eine eigene "nie 3 Tage frei"-Regel.
  // Zwingt man ihnen zusaetzlich 24+ Arbeitstage auf, sprengt die Vorlage das
  // Stundenziel (100 Std. wurden zu 125,8).
  // Ausdrückliche Vorgabe aus dem Formular hat Vorrang – sie gilt bei JEDER
  // Stundenzahl, auch unter 100 Std. Ohne Vorgabe greift die automatische
  // Regel erst ab FREE_DAY_RULE_MIN_HOURS.
  // Bereits im Kalender als "Frei" markierte Tage sind Teil des Kontingents:
  // wer 7 freie Tage vorgibt und 7 davon selbst gesetzt hat, bekommt vom
  // Planer keinen weiteren freien Tag mehr dazu. Urlaubs- und Krankheitstage
  // zaehlen hier bewusst nicht mit.
  const freieTageVorgabeGesamt = target.maxFreeDays != null && target.maxFreeDays >= 0 ? target.maxFreeDays : null
  const freieTageVorgabe =
    freieTageVorgabeGesamt != null ? Math.max(0, freieTageVorgabeGesamt - (target.preFreeDays ?? 0)) : null
  const freieTageRegelGilt =
    !isEinzelfahrer && (freieTageVorgabe != null || target.totalHours >= FREE_DAY_RULE_MIN_HOURS)
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
    // Obergrenze für freie Tage ab FREE_DAY_RULE_MIN_HOURS. Vorher griff sie
    // erst über 129 Std. – ein 100-Std.-Fahrer bekam deshalb 15 freie Tage.
    const freeDayCap = freieTageVorgabe ?? Math.min(targetFreeDaysFloor, MAX_FREE_DAYS)
    const minRestDaysForFreeTarget = freieTageRegelGilt
      ? Math.max(0, allDays.length - freeDayCap - chosenSundays.length)
      : 0
    const maxFeasibleRestDays = restPool.length > 0 ? Math.floor(remainingHours / ABS_MIN_NET) : 0
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

  // ---- Ziel-Nachtstunden (target.nightHours): eine Teilmenge der bereits
  // gewählten Arbeitstage wird für nachtoptimierte Startzeiten vorgemerkt -
  // analog zur Sonntagsstunden-Zuteilung (max. 8 Std./Tag angenommen, da
  // eine Schicht dieser Länge komplett ins 20-06-Uhr-Fenster passt). Nur
  // FLEXIBLE Tage kommen infrage - Sonntage mit eigener dedizierter
  // Stundenzuteilung werden ausgeschlossen, damit eine spätere Startzeit
  // dort nicht in den Montag hinein "spillt" und die exakte Sonntagsstunden-
  // Zuteilung verfälscht.
  const nightTargetDates = new Set<string>()
  if (target.nightHours > 0) {
    const sundayDedicatedDates = new Set(minijobSundayHoursByDate ? Array.from(minijobSundayHoursByDate.keys()) : [])
    const nightCandidatePool = chosenWeekdays.filter((d) => !sundayDedicatedDates.has(toDateStr(d)))
    const numNightShifts = Math.max(1, Math.ceil(target.nightHours / 8))
    pickDaysEdgeFirst(nightCandidatePool, Math.min(numNightShifts, nightCandidatePool.length)).forEach((d) => nightTargetDates.add(toDateStr(d)))
  }

  // ---- Schritt 1: Pro gewähltem Tag zuerst die PAUSE bestimmen (hängt nur
  // vom Wochentag/Nachfrageprofil ab, nicht von der genauen Nettozeit),
  // daraus die tagesindividuelle 10h-Obergrenze für die Nettoarbeitszeit
  // ableiten. An Freitagen/Samstagen zusätzlich eine Mindest-BRUTTO-
  // arbeitszeit (Netto + Pause) von 6 Std. sicherstellen, auch wenn die
  // Nettoarbeitszeit dabei durchaus unter 8 Std. bleiben darf. ----
  // ---- Höchstens MAX_FREE_DAYS_PER_WEEK freie Tage in JEDEM 7-Tage-Fenster.
  // Ein Monatsdeckel allein genügt nicht: 6 freie Tage könnten sich in einer
  // einzigen Woche ballen. Geprüft wird gleitend (Tag 1-7, 2-8, …), nicht nach
  // Kalenderwochen – sonst rutschten drei freie Tage über den Wochenwechsel
  // durch. Gilt erst ab FREE_DAY_RULE_MIN_HOURS und nur so weit, wie das
  // Stundenbudget zusätzliche Tage überhaupt trägt. ----
  if (freieTageRegelGilt && allDays.length >= 7) {
    const maxDaysByBudget = Math.floor(target.totalHours / ABS_MIN_NET)
    const working = new Set(chosenWeekdays.map(toDateStr))
    let added = 0
    for (let start = 0; start + 7 <= allDays.length; start++) {
      const fenster = allDays.slice(start, start + 7)
      let frei = fenster.filter((d) => !working.has(toDateStr(d)))
      while (frei.length > MAX_FREE_DAYS_PER_WEEK && working.size < maxDaysByBudget) {
        // Den mittleren freien Tag zum Arbeitstag machen – das bricht lange
        // Blöcke auf, statt nur am Rand zu knabbern.
        const kandidat = frei[Math.floor(frei.length / 2)]
        working.add(toDateStr(kandidat))
        chosenWeekdays.push(kandidat)
        added++
        frei = fenster.filter((d) => !working.has(toDateStr(d)))
      }
    }
    if (added > 0) {
      chosenWeekdays = chosenWeekdays.sort((a, b) => a.getTime() - b.getTime())
      reservePool = reservePool.filter((d) => !working.has(toDateStr(d)))
    }
  }

  const MIN_GROSS_FRI_SAT_MINUTES = 6 * 60

  // Mindest-Nettozeit für DIESEN Plan. Verlangt die Obergrenze für freie Tage
  // mehr Arbeitstage, als das Stundenbudget bei 5 Std./Tag hergibt, muss die
  // Mindestschicht mitgehen – sonst würde die Monatssumme das Ziel sprengen
  // (24 Tage × 5 Std. = 120 Std. bei einem 100-Std.-Ziel). Nach unten begrenzt
  // durch ABS_MIN_NET, damit keine Zwergschichten entstehen.
  const effMinNetHours = chosenWeekdays.length > 0
    ? Math.max(ABS_MIN_NET, Math.min(BASE_MIN_NET, target.totalHours / chosenWeekdays.length))
    : BASE_MIN_NET

  function buildContext(day: Date): DayContext {
    const weekday = day.getDay()
    const legalMinBreak = Math.max(BUSINESS_MIN_BREAK, requiredBreakMinutes(BASE_MIN_NET))
    // Zufällige Pausenlänge zwischen 30 und 120 Minuten
    // (in 15-Min.-Schritten), statt immer exakt am Minimum zu bleiben -
    // sorgt für realistischere, nicht jeden Tag identische Pausenzeiten.
    // Eine explizite Vorgabe (breakMinutesOverride) hat weiterhin Vorrang.
    // Ob die tatsächliche Nettozeit dieses Tages die 60-Min.-Pflichtpause
    // (ab 6 Std. netto) erfordert, steht hier noch nicht fest (netHours
    // wird erst in Schritt 2 verteilt) - die endgültige Korrektur passiert
    // in Schritt 3 anhand der dann feststehenden Nettozeit.
    const randomBreakSteps = Math.floor((MAX_BREAK_MINUTES - legalMinBreak) / 15)
    const randomBreak = legalMinBreak + Math.floor(Math.random() * (randomBreakSteps + 1)) * 15
    let breakMinutes = target.breakMinutesOverride != null ? Math.max(target.breakMinutesOverride, legalMinBreak) : randomBreak

    const isNightTarget = nightTargetDates.has(toDateStr(day))
    const lowestWindow = target.prioritizeDemand && !target.maximizeNight && !isNightTarget
      ? pickLowestDemandWindow(weekday, demandProfiles)
      : null
    if (lowestWindow) breakMinutes = Math.max(breakMinutes, Math.min(MAX_BREAK_MINUTES, lowestWindow.durationMinutes))

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
    const minNetForEightHours = effMinNetHours * 60
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
    // Freitage sind bei der festen Einzelfahrer-Vorlage STRUKTURELL IMMER
    // Spesen-berechtigt (7,5 Std. netto + 30 Min. Pause + Arbeitsweg >= 8
    // Std. Gesamtzeit, unabhängig von Budget/Flags) - das MUSS hier
    // abgezogen werden, sonst wird für zusätzliche Werktage mehr Budget
    // "reserviert" (höhere Mindestzeit erzwungen) als nötig.
    const alreadyQualifyingElsewhere = isEinzelfahrer
      ? allDays.filter((d) => d.getDay() === 5).length
      : Array.from(minijobSundayHoursByDate?.values() ?? []).filter((h) => h * 60 >= qualifyThresholdMinutes).length
    const minNeededForBump = Math.max(BASE_MIN_NET * 60, TARGET_TOTAL_MIN * 60 - MAX_BREAK_STEP_MINUTES - commuteMinutes)
    // Zusätzliche, WICHTIGERE Deckelung: nie mehr Tage auf die erhöhte
    // Mindestzeit heben, als das verbleibende Stundenbudget (remainingHours)
    // überhaupt hergibt - sonst kann distributeHoursWithPerDayCap nicht
    // mehr unter die Summe der (dann zu hohen) Mindestwerte sinken und die
    // Monatssumme läuft der eingegebenen Stundenzahl davon (das widerspricht
    // dem oben beschriebenen "Gesamtsumme hat Vorrang"-Grundsatz).
    const affordableQualifyingDays = Math.max(0, Math.floor(remainingHours / (minNeededForBump / 60)))
    const maxQualifyingDays = Math.min(
      Math.max(0, Math.round(target.spesenDaysTarget) - alreadyQualifyingElsewhere),
      affordableQualifyingDays
    )
    const allCandidates = [...distributableWeekdayContexts, ...reserveContexts]
    const shuffled = [...allCandidates].sort(() => Math.random() - 0.5)
    const unrestrictedSet = new Set(shuffled.slice(0, maxQualifyingDays).map((c) => c.dateStr))
    spesenUnrestrictedDates = unrestrictedSet
    const safeMaxNetMinutes = Math.max(BASE_MIN_NET * 60, qualifyThresholdMinutes - 15)
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
  // Tage, an denen das Fahrzeug bereits durchgehend von anderen Fahrern
  // belegt war - fuer den Hinweis am Ende.
  const uebersprungeneTage: { date: string; netHours: number }[] = []

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

      // Betriebliche Mindestpause (ab 6 Std. netto mind. 60 Min.) durchsetzen
      // - die feste Vorlage allein (z. B. Freitag: 30 Min.) unterschreitet
      // das sonst bei ihrer festen Nettozeit von 7,5 Std.
      breakMinutes = Math.max(breakMinutes, requiredBreakMinutes(netHours))

      const breakStartOffset = isSundayFixed ? Math.round(netMinutes / 2) : fixed!.breakStart

      // 8-Std.-Mindestgesamtzeit gilt auch hier (Vollzeit) - die feste
      // Nettozeit aus der Vorlage bleibt UNVERÄNDERT, nur die Pause wird
      // bei Bedarf stufenweise verlängert (45 -> 60 -> 90 -> 120 Min.).
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

    // Betriebliche Mindestpause anhand der jetzt feststehenden Nettozeit
    // durchsetzen (ab 6 Std. netto mind. 60 Min., siehe requiredBreakMinutes)
    // - unabhängig von Spesen-Berechnung, da dies eine harte Vorgabe ist.
    const requiredMinBreak = requiredBreakMinutes(netHours)
    if (ctx.breakMinutes < requiredMinBreak) ctx.breakMinutes = requiredMinBreak

    // Vollzeit-Erkennung: bei aktivierter Spesen-Berechnung ODER ab 100
    // Netto-Std./Monat MUSS die Gesamtzeit (Netto + Pause + Arbeitsweg)
    // mindestens 8 Std. betragen (Voraussetzung für Verpflegungsmehr-
    // aufwand). Reicht die Nettoarbeitszeit dafür allein nicht aus, wird
    // die Pause stufenweise erhöht (45 -> 60 -> 90 -> 120 Minuten) -
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
      // Verschieben, bis sowohl die Ruhezeit des Fahrers als auch die
      // Belegung des Fahrzeugs passen. Die Obergrenze verhindert eine
      // Endlosschleife, falls beides nie gleichzeitig erfüllbar ist.
      let versuche = 0
      while (versuche++ < 96) {
        const candDate = new Date(ctx.date.getFullYear(), ctx.date.getMonth(), ctx.date.getDate(), 0, candidateStart, 0, 0)
        const ruheOk = !prevEnd || (candDate.getTime() - prevEnd.getTime()) / 3600000 >= minRestHours
        const wagenFrei = !vehicleConflict(vehicleBusy, ctx.dateStr, candidateStart, candidateStart + spanMinutes)
        if (ruheOk && wagenFrei) break
        candidateStart += 15
        breakStartAbs += 15
      }
      // Auch hier gilt: findet sich kein freies Fenster, entsteht keine
      // Schicht - lieber ein Tag weniger als zwei Fahrer gleichzeitig im
      // selben Wagen.
      if (vehicleConflict(vehicleBusy, ctx.dateStr, candidateStart, candidateStart + spanMinutes)) {
        uebersprungeneTage.push({ date: ctx.dateStr, netHours })
        return
      }
      startMin = candidateStart
      const breakRelStart = breakStartAbs - startMin
      breaks = [{ start: breakRelStart, end: breakRelStart + ctx.breakMinutes }]
    } else {
      const randomPreferredStart = 5 * 60 + Math.floor(Math.random() * 4 * 60) // 05:00-09:00, zufällig

      // Samstagsschichten dürfen NIE in den Sonntag hineinreichen - dieser
      // Überlauf wird nirgends im sundayHours-Budget berücksichtigt
      // (Sonntagsstunden entstehen in diesem Zweig AUSSCHLIESSLICH über die
      // dedizierten Sonntagsschichten, siehe minijobSundayHoursByDate).
      // Ohne diese Schranke könnte selbst bei sundayHours = 0 (der Nutzer
      // will explizit KEINE Sonntagsarbeit) eine ungewollte Sonntagsstunde
      // entstehen, z. B. wenn "Nachtzuschläge maximieren" den Samstag auf
      // eine sehr späte Startzeit schiebt, die über Mitternacht hinausläuft.
      const mustStayInDay = ctx.weekday === 6
      const searchLatest = mustStayInDay ? Math.max(0, 1440 - spanMinutes) : START_WINDOW.latest

      const isNightTarget = nightTargetDates.has(ctx.dateStr)
      let bestStart = -1
      let bestScore = -Infinity
      for (let cand = START_WINDOW.earliest; cand <= searchLatest; cand += 15) {
        const candStart = new Date(ctx.date.getFullYear(), ctx.date.getMonth(), ctx.date.getDate(), 0, cand, 0, 0)
        if (prevEnd && (candStart.getTime() - prevEnd.getTime()) / 3600000 < minRestHours) continue
        // Das Fahrzeug darf zu dieser Zeit nicht schon mit einem anderen
        // Fahrer unterwegs sein (Nacht- und Tagschicht am selben Datum sind
        // erlaubt, solange sie sich nicht überschneiden).
        if (vehicleConflict(vehicleBusy, ctx.dateStr, cand, cand + spanMinutes)) continue
        const baseScore = target.maximizeNight || isNightTarget
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

      // Kein einziger Startzeitpunkt zulaessig - das Fahrzeug ist an diesem
      // Tag durchgehend von anderen Fahrern belegt (oder die Ruhezeit laesst
      // keinen Platz). Frueher blieb bestStart auf 04:00 stehen und die
      // Schicht wurde ueber die eines Kollegen gelegt; ab drei Fahrern je
      // Fahrzeug passierte das regelmaessig. Jetzt entsteht an dem Tag
      // schlicht keine Schicht, die Stunden wandern auf andere Tage.
      if (bestStart < 0) {
        uebersprungeneTage.push({ date: ctx.dateStr, netHours })
        return
      }
      startMin = bestStart

      if (target.maximizeNight || target.prioritizeDemand || isNightTarget) {
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

  // ---- Nachplatzierung: Tage, an denen das Fahrzeug schon belegt war ----
  //
  // Die Tagesauswahl weiter oben kennt die Fahrzeugbelegung nicht - sie legt
  // fuer jeden Fahrer dieselben "schoenen" Tage nahe. Bei drei oder mehr
  // Fahrern an EINEM Wagen faellt der Spaetere dadurch ganz heraus. Genau
  // dafuer ist dieser Durchlauf da: die Stunden eines belegten Tages wandern
  // auf einen anderen Kalendertag, an dem der Wagen noch frei ist. Bevorzugt
  // werden Tage, an denen das Fahrzeug noch GAR NICHT unterwegs ist - ein
  // Minijobber faehrt so an eigenen Tagen statt als dritte Schicht.
  if (uebersprungeneTage.length > 0) {
    const absolutMin = (dateStr: string, minute: number) =>
      Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 60000) + minute
    /** Haelt der Fahrer selbst die Ruhezeit zu allen seinen anderen Schichten ein? */
    const ruhezeitOk = (dateStr: string, start: number, end: number) =>
      shifts.every((s) => {
        const aVon = absolutMin(dateStr, start), aBis = absolutMin(dateStr, end)
        const bVon = absolutMin(s.date, s.startMin), bBis = absolutMin(s.date, s.endMin)
        const luecke = aVon >= bBis ? aVon - bBis : bVon - aBis
        return luecke >= minRestHours * 60
      })

    const nichtPlatziert: { date: string; netHours: number }[] = []
    for (const offen of uebersprungeneTage) {
      const eigene = new Set(shifts.map((s) => s.date))
      const netMinutes = Math.round(offen.netHours * 60)
      // Freie Tage des Fahrers, komplett unbenutzte Fahrzeugtage zuerst.
      const kandidaten = allDays
        .filter((d) => !eigene.has(toDateStr(d)))
        .sort((a, b) => (vehicleBusy?.get(toDateStr(a))?.length ?? 0) - (vehicleBusy?.get(toDateStr(b))?.length ?? 0))

      let platziert = false
      for (const day of kandidaten) {
        const dateStr = toDateStr(day)
        const ctx = buildContext(day)
        const breakMinutes = Math.max(ctx.breakMinutes, requiredBreakMinutes(offen.netHours))
        const spanMinutes = netMinutes + breakMinutes
        for (let start = START_WINDOW.earliest; start <= START_WINDOW.latest; start += 15) {
          if (vehicleConflict(vehicleBusy, dateStr, start, start + spanMinutes)) continue
          if (!ruhezeitOk(dateStr, start, start + spanMinutes)) continue
          shifts.push({
            driverId: target.driverId, date: dateStr, startMin: start, endMin: start + spanMinutes,
            breakMinutes, breaks: positionBreak(spanMinutes, breakMinutes),
            netHours: offen.netHours, commuteMinutes
          })
          platziert = true
          break
        }
        if (platziert) break
      }
      if (!platziert) nichtPlatziert.push(offen)
    }
    uebersprungeneTage.length = 0
    uebersprungeneTage.push(...nichtPlatziert)
    shifts.sort((a, b) => a.date.localeCompare(b.date))
  }

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
  if (freieTageRegelGilt) {
    const TARGET_FREE_DAYS = freieTageVorgabe ?? Math.min(targetFreeDaysFloor, MAX_FREE_DAYS) // Priorität: im Zielbereich landen, nicht nur irgendwo unter der Obergrenze
    const MIN_SHIFT_FLOOR_CANDIDATES = [BASE_MIN_NET, 4, ABS_MIN_NET] // Std., der Reihe nach versucht
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
        if (candidates.length === 0) {
          // Kein zulässiger freier Tag für die neue Schicht gefunden - die
          // bereits vorgenommenen Spender-Kürzungen müssen rückgängig
          // gemacht werden, sonst gehen die entnommenen Stunden ersatzlos
          // verloren (Monatssumme würde unter die Eingabe fallen).
          reductions.forEach(({ shift, amountMinutes }) => {
            shift.netHours = Math.round((shift.netHours + amountMinutes / 60) * 100) / 100
            shift.endMin += amountMinutes
          })
          break
        }
        const [newDay] = pickDaysEdgeFirst(candidates, 1)
        const newCtx = buildContext(newDay)
        const netHours = accumulated / 60
        const netMinutes = accumulated
        // Betriebliche Mindestpause anhand der jetzt feststehenden Nettozeit
        // dieser neu angelegten Schicht durchsetzen (siehe Schritt 3).
        const newBreakMinutes = Math.max(newCtx.breakMinutes, requiredBreakMinutes(netHours))
        const spanMinutes = netMinutes + newBreakMinutes
        // Startzeit bevorzugt 06:00-10:00, aber nur wo das Fahrzeug frei ist -
        // sonst weiter durch den Tag suchen. Ist der Wagen ganztags belegt,
        // taugt dieser Tag nicht und die Kuerzungen werden zurueckgenommen.
        const wunschStart = 6 * 60 + Math.floor(Math.random() * 4 * 60)
        let startMin = -1
        for (let versatz = 0; versatz <= 18 * 60; versatz += 15) {
          for (const cand of [wunschStart + versatz, wunschStart - versatz]) {
            if (cand < 0 || cand > 22 * 60) continue
            if (vehicleConflict(vehicleBusy, toDateStr(newDay), cand, cand + spanMinutes)) continue
            startMin = cand
            break
          }
          if (startMin >= 0) break
        }
        if (startMin < 0) {
          reductions.forEach(({ shift, amountMinutes }) => {
            shift.netHours = Math.round((shift.netHours + amountMinutes / 60) * 100) / 100
            shift.endMin += amountMinutes
          })
          break
        }
        const endMin = startMin + spanMinutes
        const newBreaks = positionBreak(spanMinutes, newBreakMinutes)

        shifts.push({
          driverId: target.driverId, date: toDateStr(newDay), startMin, endMin,
          breakMinutes: newBreakMinutes, breaks: newBreaks, netHours, commuteMinutes
        })
      }
      if (freeDates().length <= TARGET_FREE_DAYS) break // Ziel erreicht, weitere Stufen nicht mehr nötig
    }

    // Hinweis nur, wenn das Ziel wirklich verfehlt wurde. Die genaue Begründung
    // steht in der Prüfung weiter unten (Stundenbudget bzw. 6-Tage-Regel).
    if (freeDates().length > TARGET_FREE_DAYS && freieTageVorgabe == null) {
      warnings.push(
        `Freie Tage (${freeDates().length}) konnten nicht auf ${TARGET_FREE_DAYS} gesenkt werden - ` +
        `selbst mit auf ${ABS_MIN_NET} Std. abgesenkter Mindestschichtgröße reicht die Gesamtstundenzahl dafür nicht aus.`,
      )
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
        // (betriebliche Praxisgrenze) angekommen ist.
        const candidates = shifts
          .filter((s) => grossHours(s) < 7.99 && s.breakMinutes < MAX_BREAK_MINUTES && grossHours(s) + 0.25 <= TARGET_TOTAL_MAX + 0.001)
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
        // unter die betriebliche Mindestpause (60 Min. ab 6 Std. netto,
        // sonst 30 Min.).
        const candidates = shifts
          .filter((s) => grossHours(s) >= 7.99 && s.breakMinutes > Math.max(BUSINESS_MIN_BREAK, requiredBreakMinutes(s.netHours)))
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

  // ---- Finale Ruhezeit-Prüfung (§ 5 ArbZG: mind. `minRestHours` Std.
  // zwischen zwei Schichten) ---- Fängt jede Verletzung ab, egal wodurch sie
  // entstanden ist: die feste Wochenend-Vorlage (feste Startzeiten ohne
  // Ruhezeit-Prüfung), das nachträgliche Auffüllen freier Tage (zufällige
  // Startzeit) oder die nachträgliche Pausen-Verlängerung (verschiebt das
  // Schichtende). Die spätere Schicht wird so weit nach hinten geschoben,
  // bis die Ruhezeit eingehalten ist (Nettozeit und Pausen bleiben dabei
  // unverändert - nur die Uhrzeit verschiebt sich). Lässt sich das innerhalb
  // desselben Kalendertags nicht mehr sinnvoll erreichen, wird die Schicht
  // freigegeben (wie bei der 6-Tage-Regel), statt einen rechtswidrigen Plan
  // auszugeben.
  {
    const shiftStartAbs = (s: HoursShift) => {
      const [y, mo, d] = s.date.split('-').map(Number)
      return new Date(y, mo - 1, d, 0, s.startMin, 0, 0).getTime()
    }
    const shiftEndAbs = (s: HoursShift) => {
      const [y, mo, d] = s.date.split('-').map(Number)
      return new Date(y, mo - 1, d, 0, s.endMin, 0, 0).getTime()
    }
    const minRestMs = minRestHours * 3600000
    const MAX_START_MIN = 22 * 60 // spätestmögliche Startzeit, damit die Schicht am selben Kalendertag beginnt

    let guard = 0
    while (guard < 200) {
      guard++
      const ordered = [...shifts].sort((a, b) => shiftStartAbs(a) - shiftStartAbs(b))
      let fixedSomething = false
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1]
        const curr = ordered[i]
        const restMs = shiftStartAbs(curr) - shiftEndAbs(prev)
        if (restMs >= minRestMs - 1000) continue // ok (kleine Toleranz gegen Rundung)

        const deltaMin = Math.ceil((minRestMs - restMs) / 60000)
        if (curr.startMin + deltaMin <= MAX_START_MIN) {
          // Schicht als Ganzes nach hinten schieben - Pausen sind relativ zum
          // Schichtbeginn gespeichert und bleiben dadurch korrekt.
          curr.startMin += deltaMin
          curr.endMin += deltaMin
        } else {
          // Nicht mehr sinnvoll verschiebbar - Schicht freigeben.
          const idx = shifts.findIndex((s) => s.date === curr.date && s.startMin === curr.startMin && s.endMin === curr.endMin)
          if (idx !== -1) {
            shifts.splice(idx, 1)
            warnings.push(`${curr.date}: Schicht freigegeben, um die gesetzliche Mindestruhezeit von ${minRestHours} Std. zwischen zwei Schichten einzuhalten.`)
          }
        }
        fixedSomething = true
        break
      }
      if (!fixedSomething) break
    }
  }

  if (target.nightHours > 0) {
    const deliveredNightMinutes = shifts.reduce((sum, s) => {
      let mins = nightOverlapMinutes(s.startMin, s.endMin)
      s.breaks.forEach((b) => {
        mins -= nightOverlapMinutes(s.startMin + b.start, s.startMin + b.end)
      })
      return sum + mins
    }, 0)
    const deliveredNightHours = deliveredNightMinutes / 60
    if (Math.abs(deliveredNightHours - target.nightHours) > 0.5) {
      warnings.push(`Nachtstunden-Ziel (${target.nightHours}) konnte nicht exakt erreicht werden (${deliveredNightHours.toFixed(2)} Std. generiert) - vermutlich reichen die verfügbaren Tage/Zeitfenster dafür nicht aus.`)
    }
  }

  // Fahrzeug ganztags von Kollegen belegt: die Stunden dieser Tage konnten
  // nur verteilt werden, soweit andere Tage noch Platz hatten.
  const fehlend = target.totalHours - shifts.reduce((s, x) => s + x.netHours, 0)
  if (uebersprungeneTage.length > 0 && fehlend > 0.05) {
    const tage = uebersprungeneTage.map((d) => d.date.slice(8)).join('., ')
    warnings.push(
      `${fehlend.toFixed(2)} Std. konnten nicht verplant werden: an ${uebersprungeneTage.length} Tag(en) ` +
      `(${tage}.) war das Fahrzeug bereits durchgehend von anderen Fahrern belegt. ` +
      `Mehr Stunden gehen an diesem Wagen nur, wenn ein Kollege Tage abgibt.`
    )
  }

  // Ist die gewuenschte Zahl freier Tage ueberhaupt erreichbar? Bei 72 Std.
  // und 3,5 Std. Mindestschicht sind hoechstens 20 Arbeitstage moeglich - wer
  // dann 6 freie Tage verlangt, bekommt sie nicht, und das muss dastehen.
  if (freieTageVorgabe != null) {
    const freieTage = allDays.length - shifts.length
    if (freieTage > freieTageVorgabe) {
      // Zwei mögliche Ursachen, und sie sind unterschiedlich zu beheben:
      // zu wenig Stunden für mehr Arbeitstage – oder die gesetzliche Regel,
      // dass nach spätestens 6 Arbeitstagen ein freier Tag folgen muss.
      const maxTageNachBudget = Math.floor(target.totalHours / ABS_MIN_NET)
      const freiNachBudget = Math.max(0, allDays.length - maxTageNachBudget)
      const freiNachGesetz = Math.floor(allDays.length / 7)
      const grund = freiNachBudget >= freieTage
        ? `Mit ${target.totalHours} Std. und mindestens ${ABS_MIN_NET} Std. je Schicht sind höchstens ` +
          `${maxTageNachBudget} Arbeitstage möglich – weniger als ${freiNachBudget} freie Tage gehen daher nicht.`
        : freiNachGesetz >= freieTage
          ? `Nach spätestens 6 Arbeitstagen muss ein freier Tag folgen (§ 11 ArbZG) – ` +
            `in diesem Monat sind das mindestens ${freiNachGesetz} freie Tage.`
          : `Die Schichten liessen sich nicht dichter legen, ohne Ruhezeiten oder die ` +
            `Stundenvorgabe zu verletzen. Ein erneuter Durchlauf kann ein anderes Muster ergeben.`
      // In der Meldung die GESAMTZAHL nennen (selbst markierte freie Tage
      // eingerechnet) - das ist die Zahl, die der Nutzer im Formular vorgibt
      // und hinterher in der Zusammenfassung wiederfindet.
      const vorab = target.preFreeDays ?? 0
      warnings.push(
        `${freieTage + vorab} freie Tage statt der gewünschten ${freieTageVorgabeGesamt}` +
        `${vorab > 0 ? ` (davon ${vorab} selbst im Kalender markiert)` : ''}. ${grund}`
      )
    }
  }

  return { shifts, warning: warnings.length > 0 ? warnings.join(' ') : null }
}

/**
 * Öffentlicher Einstiegspunkt: versucht bei gesetztem Spesen-Tage-Ziel
 * automatisch mehrere Kombinationen aus freier-Tage-Untergrenze (4 -> 5 -> 6
 * -> 7 - der bei Vollzeit, > 129 Std./Monat, zulässige Gesamtbereich) und
 * (wegen der Zufallselemente in der Tagesauswahl/Pausenlänge) je zwei
 * Wiederholungen pro Stufe. Mehr freie Tage bei gleicher Gesamtstundenzahl
 * bedeuten mehr Stunden pro Arbeitstag, was das Erreichen der 8h-Spesen-
 * Grenze an mehr Tagen erleichtert - ist aber NICHT garantiert monoton
 * (unterschiedliche Zufallsauswahl je Versuch), daher die Wiederholungen.
 *
 * Auswahl: Von allen Versuchen, die (bei Vollzeit) das Freie-Tage-Ziel
 * (<= 7) einhalten, wird der mit der geringsten Abweichung vom Spesen-Ziel
 * gewählt - ein Versuch, der zwar näher am Spesen-Ziel liegt, aber das
 * Freie-Tage-Ziel verfehlt, wird NICHT bevorzugt, wenn ein anderer Versuch
 * beide Ziele besser vereint. Erfüllt keiner der Versuche das Freie-Tage-
 * Ziel, wird unter allen Versuchen der mit der geringsten Spesen-Abweichung
 * gewählt (bei Gleichstand der mit den wenigsten freien Tagen).
 */
export function generateHoursBasedSchedule(
  year: number,
  month0: number,
  target: HoursTarget,
  blockedDates: Set<string>,
  nightStart: string,
  nightEnd: string,
  minRestHours: number,
  demandProfiles: DemandProfileInput[] = [],
  vehicleBusy?: VehicleBusy
): { shifts: HoursShift[]; warning: string | null } {
  if (!target.spesenDaysTarget || target.spesenDaysTarget <= 0) {
    return generateHoursBasedScheduleAttempt(year, month0, target, blockedDates, nightStart, nightEnd, minRestHours, demandProfiles, 5, vehicleBusy)
  }

  const spesenTarget = Math.round(target.spesenDaysTarget)
  const excludedDateSetForCount = new Set(target.excludedDates ?? [])
  const allDaysCount = daysInMonth(year, month0).filter(
    (d) => !blockedDates.has(toDateStr(d)) && !excludedDateSetForCount.has(toDateStr(d)) && (!target.hireDate || toDateStr(d) >= target.hireDate)
  ).length
  const freieTageZiel = target.maxFreeDays != null && target.maxFreeDays >= 0 ? target.maxFreeDays : null
  const freeDaysOk = (workDays: number) =>
    target.isEinzelfahrer === true ||
    (freieTageZiel == null && target.totalHours < FREE_DAY_RULE_MIN_HOURS) ||
    allDaysCount - workDays <= (freieTageZiel ?? MAX_FREE_DAYS)

  const candidates: { attempt: { shifts: HoursShift[]; warning: string | null }; gap: number; freeDays: number }[] = []

  for (const floor of [4, 5, 6, 7]) {
    for (let retry = 0; retry < 2; retry++) {
      const attempt = generateHoursBasedScheduleAttempt(year, month0, target, blockedDates, nightStart, nightEnd, minRestHours, demandProfiles, floor, vehicleBusy)
      const qualifyingDays = attempt.shifts.filter((s) => s.netHours + s.breakMinutes / 60 + s.commuteMinutes / 60 >= 7.99).length
      const gap = Math.abs(qualifyingDays - spesenTarget)
      const freeDays = allDaysCount - attempt.shifts.length
      if (gap === 0 && freeDaysOk(attempt.shifts.length)) return attempt // beide Ziele exakt getroffen, kein weiterer Versuch nötig
      candidates.push({ attempt, gap, freeDays })
    }
  }

  const withinFreeDaysTarget = candidates.filter((c) => freeDaysOk(allDaysCount - c.freeDays))
  const pool = withinFreeDaysTarget.length > 0 ? withinFreeDaysTarget : candidates
  pool.sort((a, b) => (a.gap !== b.gap ? a.gap - b.gap : a.freeDays - b.freeDays))

  return pool[0]?.attempt ?? generateHoursBasedScheduleAttempt(year, month0, target, blockedDates, nightStart, nightEnd, minRestHours, demandProfiles, 5, vehicleBusy)
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
