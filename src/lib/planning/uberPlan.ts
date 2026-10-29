// Monats-Stundenplan aus einer Uber-Datei „trip_activity“.
//
// Die Zeiten sind Wanduhrzeiten aus der CSV, ohne Zeitzonen-Umrechnung.
// Bezahlte Stunden = Beginn bis Ende. Die Pause liegt in dieser Spanne und
// ist bezahlt; sie verlängert die Schicht nicht.

import { computeShiftHours, sumShiftHours, type MonthlyHours } from './wage'

export const PAUSE_STEPS_H = [0.25, 0.5, 0.75, 1, 1.25, 1.5] as const
export const MAX_PAUSE_H = 1.5
export const MAX_SHIFT_H = 10
export const MIN_REST_H = 11
export const MIN_FREE_PER_WEEK = 1
export const MAX_FREE_PER_WEEK = 2
/** Erst ab fünf Tagen im Monat gilt die Wochenruhe, sonst würde eine Randwoche entleert. */
const WEEK_MIN_DAYS = 5

export const REGELN = [
  'Nur abgeschlossene Fahrten. Start ist der Zeitpunkt der Fahrtbestellung, Ende die Ankunft.',
  'Die längste Lücke einer Schicht ist die Pause. Sie wird auf 0,25 / 0,50 / 0,75 / 1,00 / 1,25 / 1,50 Stunden gerundet.',
  'Die Pause ist bezahlt. Bezahlte Stunden sind Ende minus Start.',
  'Eine Lücke über 1,50 Stunden ist Feierabend, wenn danach mindestens 11 Stunden Ruhe liegen oder die Schicht sonst über 10 Stunden käme.',
  'Eine Schicht dauert höchstens 10 Stunden. Was danach noch vor Ablauf der 11 Stunden Ruhe gefahren wurde, steht als Hinweis und zählt nicht als zweite Schicht.',
  'Nach Feierabend beginnt die nächste Schicht frühestens nach 11 Stunden.',
  'Unter 6 Stunden Netto keine Pflichtpause, ab 6 Stunden 0,50, über 9 Stunden 0,75. Das ist die Untergrenze, die Lücke darf länger sein.',
  'Je Kalenderwoche mit mindestens fünf Tagen im Monat: mindestens ein und höchstens zwei freie Tage. Fehlt der Ruhetag, entfällt der Tag mit den wenigsten Stunden. Tage ohne Fahrten bleiben frei und werden nicht aufgefüllt.',
] as const

const H = 3600000
const EPS = 1e-6

export type Trip = { startMs: number; endMs: number }

export type PlanShift = {
  date: string
  startMs: number
  endMs: number
  startMin: number
  endMin: number
  pauseH: number
  /** Minuten seit Schichtbeginn. */
  pauseAt: { start: number; end: number }[]
  paidH: number
  nettoH: number
  restH: number | null
  hinweis: string
}

export type PlanDay = {
  date: string
  weekday: number
  kind: 'schicht' | 'frei' | 'ruhetag' | 'ausgelassen' | 'krank'
  shifts: PlanShift[]
  hinweis: string
  /** Gefahren, aber nicht geplant: liegt in der 11-Stunden-Ruhe. */
  ausgelassen: string
}

export type DriverPlan = {
  name: string
  month: string
  days: PlanDay[]
  /** Brutto/Anwesenheit = Σ Schichtspannen (Pause drin). */
  paidH: number
  /** Bezahlte Arbeitszeit = Σ (Spanne minus Pause). Lohnbasis. */
  nettoH: number
  workDays: number
  freeDays: number
  ruheTage: number
  violations: number
  weekNotes: string[]
  /** Gesetzliche Feiertage des Monats als "YYYY-MM-DD" (für die 125 %-Zuordnung). */
  feiertage?: string[]
  /** Soll-Vorgaben aus der Lohnabrechnung (zum Abgleich im Export), falls gesetzt. */
  ziel?: { gesamt: number; sonntag: number; nacht25: number; nacht40: number; feiertag: number }
  /** Krank-Stunden des Monats (Lohnfortzahlung § 3 EntgFG), falls Kranktage gesetzt. */
  sickHours?: number
}

const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "2026-09-30 23:30:52" als Wanduhr, unabhängig von der Zeitzone des Rechners. */
export function parseWall(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec((value || '').trim())
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
}

export function dateKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export function weekdayShort(iso: string): string {
  return WOCHENTAG[weekdayIndex(iso)]
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Eine Zeile des Monatsblatts, zum Beispiel „Di 01.09“. */
export type DayLine = {
  tag: string
  start: string
  ende: string
  /** Eine Zahl je Schicht. Zwei Schichten stehen als „1,50 / 0,25“. */
  pause: number | string | null
  stunden: number | null
  hinweis: string
}

export function tagLabel(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${weekdayShort(iso)} ${d}.${m}`
}

/** Ein Kalendertag, eine Zeile. Mehrere Schichten stehen in derselben Zeile. */
export function dayRow(day: PlanDay): DayLine {
  const tag = tagLabel(day.date)
  if (day.kind !== 'schicht' || day.shifts.length === 0) {
    return { tag, start: '', ende: '', pause: null, stunden: null, hinweis: day.kind === 'frei' ? '' : day.hinweis }
  }
  const start = day.shifts.map((s) => clock(s.startMs)).join(' / ')
  const ende = day.shifts.map((s) => `${clock(s.endMs)}${s.endMin >= 1440 ? ' +1' : ''}`).join(' / ')
  const hinweis = [...day.shifts.map((s) => s.hinweis), day.ausgelassen].filter(Boolean).join(' · ')
  const pausen = day.shifts.map((s) => round2(s.pauseH))
  const pause = pausen.length === 1
    ? pausen[0]
    : pausen.map((p) => p.toFixed(2).replace('.', ',')).join(' / ')
  return {
    tag,
    start,
    ende,
    pause,
    // „Stunden" = bezahlte Arbeitszeit (Spanne minus Pause); die Pause ist unbezahlt.
    stunden: round2(day.shifts.reduce((sum, s) => sum + s.nettoH, 0)),
    hinweis,
  }
}

const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

export function monthLabelDE(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONATE[(m || 1) - 1] || ym} ${y || ''}`.trim()
}

function hm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

/** Eine Zeile im Stundenzettel-Blatt. Zwei Schichten an einem Tag sind zwei Zeilen. */
export type TimesheetLine = {
  driverName: string
  isoDate: string
  isFree: boolean
  startMin: number
  endMin: number
  breakMinutes: number
  breakOffsetMin: number
  paidHours: number
  freeLabel: string | null
  ruheH: number | null
  night25: number
  night40: number
  sunday50: number
  holiday125: number
}

export type TimesheetView = {
  tag: string
  von: string
  bis: string
  pauseMin: number | null
  bezahlt: number | null
  ruhe: number | null
  nacht25: number | null
  nacht40: number | null
  sonntag: number | null
  feiertag: number | null
  hinweis: string
}

/**
 * Schicht für den Stundenzettel – EXAKT wie geplant.
 *
 * Früher wurden hier die Zeiten „schön gemacht" (auf die Viertelstunde gerundet,
 * jede Schicht ≥ 6 h auf 8,5 h gestreckt). Das hat die vom Ziel-/Exakt-Planer
 * genau gesetzten Stunden und Zuschlagsfenster wieder verschoben – der Export
 * wich dann von den Lohnabrechnungszahlen ab. Jetzt werden Beginn, Ende und die
 * geplante Pause (inkl. ihrer Lage) UNVERÄNDERT übernommen, damit der Export
 * minutengenau die geplanten Stunden und Zuschläge trägt.
 */
function payrollShift(s: PlanShift): { startMin: number; endMin: number; breakMinutes: number; breakOffsetMin: number } {
  const startMin = Math.round(s.startMin)
  const endMin = Math.round(s.endMin)
  const span = endMin - startMin
  let breakMinutes = Math.max(0, Math.round((s.pauseH ?? 0) * 60))
  if (breakMinutes >= span) breakMinutes = 0
  // Pausenlage möglichst exakt aus dem Plan übernehmen, sonst mittig.
  let breakOffsetMin = 0
  if (breakMinutes > 0) {
    const geplant = s.pauseAt && s.pauseAt.length ? Math.round(s.pauseAt[0].start) : null
    breakOffsetMin = geplant != null ? Math.max(0, Math.min(geplant, span - breakMinutes)) : Math.round((span - breakMinutes) / 2)
  }
  return { startMin, endMin, breakMinutes, breakOffsetMin }
}

function sheetHinweis(shiftHinweis: string, extra: string): string | null {
  const keep = shiftHinweis.split(' · ').filter((part) => part && !part.startsWith('Lücke über 1,50'))
  const text = [...keep, extra].filter(Boolean).join(' · ')
  return text || null
}

function restHours(prev: { iso: string; endMin: number }, iso: string, startMin: number): number {
  const [y1, m1, d1] = prev.iso.split('-').map(Number)
  const [y2, m2, d2] = iso.split('-').map(Number)
  const end = Date.UTC(y1, m1 - 1, d1) + prev.endMin * 60000
  const start = Date.UTC(y2, m2 - 1, d2) + startMin * 60000
  return (start - end) / 3600000
}

export function timesheetLines(plan: DriverPlan): TimesheetLine[] {
  const lines: TimesheetLine[] = []
  const feSet = new Set(plan.feiertage ?? [])
  let prev: { iso: string; endMin: number } | null = null
  for (const day of plan.days) {
    if (day.kind !== 'schicht' || day.shifts.length === 0) {
      lines.push({
        driverName: plan.name, isoDate: day.date, isFree: true,
        startMin: 0, endMin: 0, breakMinutes: 0, breakOffsetMin: 0, paidHours: 0,
        freeLabel: day.kind === 'frei' ? null : day.hinweis,
        ruheH: null, night25: 0, night40: 0, sunday50: 0, holiday125: 0,
      })
      continue
    }
    day.shifts.forEach((s, i) => {
      const pay = payrollShift(s)
      const breaks = pay.breakMinutes > 0 ? [{ start: pay.breakOffsetMin, end: pay.breakOffsetMin + pay.breakMinutes }] : []
      const hours = computeShiftHours({ date: s.date, startMin: pay.startMin, endMin: pay.endMin, breaks }, feSet)
      const ruheH = prev ? restHours(prev, s.date, pay.startMin) : null
      const extra = i === day.shifts.length - 1 ? day.ausgelassen : ''
      lines.push({
        driverName: plan.name, isoDate: s.date, isFree: false,
        startMin: pay.startMin, endMin: pay.endMin,
        breakMinutes: pay.breakMinutes, breakOffsetMin: pay.breakOffsetMin,
        paidHours: (pay.endMin - pay.startMin) / 60,
        freeLabel: sheetHinweis(s.hinweis, extra),
        ruheH, night25: hours.night25, night40: hours.night40, sunday50: hours.sunday50, holiday125: hours.holiday125,
      })
      prev = { iso: s.date, endMin: pay.endMin }
    })
  }
  return lines
}

export function timesheetHours(plan: DriverPlan): MonthlyHours {
  const shifts = timesheetLines(plan).filter((line) => !line.isFree).map((line) => ({
    date: line.isoDate,
    startMin: line.startMin,
    endMin: line.endMin,
    breaks: line.breakMinutes > 0 ? [{ start: line.breakOffsetMin, end: line.breakOffsetMin + line.breakMinutes }] : [],
  }))
  return sumShiftHours(shifts, new Set(plan.feiertage ?? []), plan.sickHours ?? 0)
}

export function timesheetView(plan: DriverPlan): TimesheetView[] {
  return timesheetLines(plan).map((line) => {
    const tag = tagLabel(line.isoDate)
    if (line.isFree) {
      return {
        tag, von: '', bis: '', pauseMin: null, bezahlt: null, ruhe: null,
        nacht25: null, nacht40: null, sonntag: null, feiertag: null,
        hinweis: line.freeLabel ?? '',
      }
    }
    return {
      tag, von: hm(line.startMin), bis: hm(line.endMin),
      pauseMin: line.breakMinutes,
      // Bezahlt = Spanne minus Pause (Pause unbezahlt).
      bezahlt: round2(Math.max(0, line.paidHours - line.breakMinutes / 60)),
      ruhe: line.ruheH == null ? null : round2(line.ruheH),
      nacht25: round2(line.night25),
      nacht40: round2(line.night40),
      sonntag: round2(line.sunday50),
      feiertag: round2(line.holiday125),
      hinweis: line.freeLabel ?? '',
    }
  })
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dateKey(dt.getTime())
}

function mondayKey(iso: string): string {
  const dow = weekdayIndex(iso)
  const back = (dow + 6) % 7
  return addDays(iso, -back)
}

export function snapPause(hours: number): number {
  if (!(hours >= 0.125)) return 0
  let best: number = PAUSE_STEPS_H[0]
  let diff = Infinity
  for (const step of PAUSE_STEPS_H) {
    const d = Math.abs(hours - step)
    if (d < diff - 1e-9) {
      best = step
      diff = d
    }
  }
  return best
}

/** Pflichtpause aus der Schichtspanne, ohne die Pause doppelt von der Nettozeit abzuziehen. */
export function statutoryPause(spanH: number): number {
  if (spanH - 0.75 > 9) return 0.75
  if (spanH - 0.5 >= 6) return 0.5
  return 0
}

type Gap = { index: number; hours: number }

function spanOf(trips: Trip[]): { start: number; end: number; hours: number } {
  let end = trips[0].endMs
  for (const t of trips) if (t.endMs > end) end = t.endMs
  const start = trips[0].startMs
  return { start, end, hours: (end - start) / H }
}

function gapsOf(trips: Trip[]): Gap[] {
  const out: Gap[] = []
  for (let i = 0; i < trips.length - 1; i++) {
    out.push({ index: i, hours: Math.max(0, (trips[i + 1].startMs - trips[i].endMs) / H) })
  }
  return out
}

function longestGap(gaps: Gap[]): Gap | null {
  let best: Gap | null = null
  for (const g of gaps) {
    if (!best || g.hours > best.hours + 1e-9) best = g
  }
  return best
}

export type Placement = { chains: Trip[][]; skipped: Trip[] }

/**
 * Schichten, die die Regeln einhalten. Fahrten, die erst nach einem
 * Feierabend und noch vor Ablauf der 11 Stunden kämen, werden nicht zu einer
 * neuen Schicht. Sie bleiben in `skipped` sichtbar.
 */
export function placeShifts(trips: Trip[]): Placement {
  const sorted = trips
    .filter((t) => t.endMs > t.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const chains: Trip[][] = []
  const skipped: Trip[] = []
  let i = 0
  while (i < sorted.length) {
    const chain: Trip[] = [sorted[i]]
    let j = i + 1
    while (j < sorted.length) {
      const end = spanOf(chain).end
      const gapH = (sorted[j].startMs - end) / H
      const nextSpan = (Math.max(end, sorted[j].endMs) - chain[0].startMs) / H
      const feierabend = gapH > MAX_PAUSE_H + EPS && (gapH + EPS >= MIN_REST_H || nextSpan > MAX_SHIFT_H + EPS)
      if (feierabend || nextSpan > MAX_SHIFT_H + EPS) break
      chain.push(sorted[j])
      j++
    }
    chains.push(chain)
    const end = spanOf(chain).end
    while (j < sorted.length && (sorted[j].startMs - end) / H + EPS < MIN_REST_H) {
      skipped.push(sorted[j])
      j++
    }
    i = j
  }
  return { chains, skipped }
}

function toShift(trips: Trip[], restH: number | null): PlanShift {
  const span = spanOf(trips)
  const gap = longestGap(gapsOf(trips).filter((g) => g.hours > 0.01))
  const gapH = gap?.hours ?? 0
  const snapped = gapH > MAX_PAUSE_H ? MAX_PAUSE_H : snapPause(gapH)
  const pauseH = Math.min(MAX_PAUSE_H, Math.max(snapped, statutoryPause(span.hours)))
  const paidH = span.hours
  const nettoH = Math.max(0, paidH - pauseH)
  const notes: string[] = []
  if (paidH > MAX_SHIFT_H + 0.02) notes.push('über 10 h, keine teilbare Lücke')
  if (gapH > MAX_PAUSE_H + EPS && pauseH === MAX_PAUSE_H) notes.push('Lücke über 1,50 h bleibt in der Schicht, Pause auf 1,50 h begrenzt')
  if (restH != null && restH + EPS < MIN_REST_H) notes.push(`Ruhezeit ${restH.toFixed(2).replace('.', ',')} h, unter 11 h`)
  const pauseMin = Math.round(pauseH * 60)
  let pauseAt: { start: number; end: number }[] = []
  if (pauseMin > 0) {
    const spanMin = Math.max(pauseMin, Math.round(paidH * 60))
    const anchor = gap ? Math.round((trips[gap.index].endMs - span.start) / 60000) : Math.round((spanMin - pauseMin) / 2)
    let start = anchor
    if (start + pauseMin > spanMin) start = spanMin - pauseMin
    if (start < 0) start = 0
    pauseAt = [{ start, end: start + pauseMin }]
  }
  const startMin = new Date(span.start).getUTCHours() * 60 + new Date(span.start).getUTCMinutes()
  let endMin = new Date(span.end).getUTCHours() * 60 + new Date(span.end).getUTCMinutes()
  const dayDiff = Math.round((Date.parse(dateKey(span.end) + 'T00:00:00Z') - Date.parse(dateKey(span.start) + 'T00:00:00Z')) / 86400000)
  endMin += dayDiff * 1440
  return {
    date: dateKey(span.start),
    startMs: span.start,
    endMs: span.end,
    startMin,
    endMin,
    pauseH: round2(pauseH),
    pauseAt,
    paidH: round2(paidH),
    nettoH: round2(nettoH),
    restH: restH == null ? null : round2(restH),
    hinweis: notes.join(' · '),
  }
}

function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number)
  const out: string[] = []
  const d = new Date(Date.UTC(y, m - 1, 1))
  while (d.getUTCMonth() === m - 1) {
    out.push(dateKey(d.getTime()))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

function majorityMonth(trips: Trip[]): string {
  const count = new Map<string, number>()
  for (const t of trips) {
    const mk = dateKey(t.startMs).slice(0, 7)
    count.set(mk, (count.get(mk) || 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

function assemblePlan(name: string, month: string, chains: Trip[][], skipped: Trip[]): DriverPlan {
  const shifts: PlanShift[] = []
  let prevEnd: number | null = null
  for (const chain of chains) {
    const start = spanOf(chain).start
    const restH = prevEnd == null ? null : (start - prevEnd) / H
    const shift = toShift(chain, restH)
    shifts.push(shift)
    prevEnd = spanOf(chain).end
  }

  const skippedByDate = new Map<string, Trip[]>()
  for (const t of skipped) {
    const iso = dateKey(t.startMs)
    const list = skippedByDate.get(iso)
    if (list) list.push(t)
    else skippedByDate.set(iso, [t])
  }
  const skippedText = (iso: string) => {
    const list = skippedByDate.get(iso)
    if (!list?.length) return ''
    const s = spanOf(list)
    return `gefahren, nicht im Plan (Ruhezeit): ${clock(s.start)}–${clock(s.end)}`
  }

  const calendar = month ? monthDays(month) : []
  const byDate = new Map<string, PlanShift[]>()
  for (const s of shifts) {
    const list = byDate.get(s.date)
    if (list) list.push(s)
    else byDate.set(s.date, [s])
  }

  const dropped = new Set<string>()
  const weekNotes: string[] = []
  const byWeek = new Map<string, string[]>()
  for (const iso of calendar) {
    const wk = mondayKey(iso)
    const list = byWeek.get(wk)
    if (list) list.push(iso)
    else byWeek.set(wk, [iso])
  }
  for (const [wk, days] of byWeek) {
    const free = () => days.filter((iso) => !byDate.has(iso) || byDate.get(iso)!.length === 0)
    if (days.length >= WEEK_MIN_DAYS && free().length < MIN_FREE_PER_WEEK) {
      let pick: { date: string; paid: number } | null = null
      for (const iso of days) {
        const paid = (byDate.get(iso) ?? []).reduce((s, sh) => s + sh.paidH, 0)
        if (paid <= 0) continue
        if (!pick || paid < pick.paid - 1e-9 || (Math.abs(paid - pick.paid) <= 1e-9 && iso > pick.date)) {
          pick = { date: iso, paid }
        }
      }
      if (pick) {
        dropped.add(pick.date)
        byDate.delete(pick.date)
        weekNotes.push(`${pick.date}: Ruhetag, wenigste Stunden der Woche (${pick.paid.toFixed(2).replace('.', ',')} h nicht geplant)`)
      }
    }
    const gearbeitet = days.some((iso) => (byDate.get(iso)?.length ?? 0) > 0)
    const frei = free().length
    if (gearbeitet && frei > MAX_FREE_PER_WEEK) {
      weekNotes.push(`Woche ab ${wk}: ${frei} Tage ohne Fahrt, nicht aufgefüllt`)
    }
  }

  const days: PlanDay[] = calendar.map((iso) => {
    const weg = skippedText(iso)
    if (dropped.has(iso)) {
      return {
        date: iso, weekday: weekdayIndex(iso), kind: 'ruhetag', shifts: [],
        hinweis: weg ? `Ruhetag (wenigste Stunden der Woche) · ${weg}` : 'Ruhetag (wenigste Stunden der Woche)',
        ausgelassen: weg,
      }
    }
    const list = byDate.get(iso) ?? []
    if (!list.length && weg) {
      return { date: iso, weekday: weekdayIndex(iso), kind: 'ausgelassen', shifts: [], hinweis: weg, ausgelassen: weg }
    }
    if (!list.length) return { date: iso, weekday: weekdayIndex(iso), kind: 'frei', shifts: [], hinweis: 'frei', ausgelassen: '' }
    return { date: iso, weekday: weekdayIndex(iso), kind: 'schicht', shifts: list, hinweis: weg, ausgelassen: weg }
  })

  let paidH = 0
  let nettoH = 0
  let workDays = 0
  let violations = 0
  for (const day of days) {
    if (day.ausgelassen) violations++
    if (day.kind !== 'schicht') continue
    workDays++
    for (const s of day.shifts) {
      paidH += s.paidH
      nettoH += s.nettoH
      if (s.hinweis) violations++
    }
  }

  return {
    name,
    month,
    days,
    paidH: round2(paidH),
    nettoH: round2(nettoH),
    workDays,
    freeDays: days.filter((d) => d.kind !== 'schicht').length,
    ruheTage: dropped.size,
    violations,
    weekNotes,
  }
}

export function planDriver(name: string, trips: Trip[]): DriverPlan {
  const month = majorityMonth(trips)
  const inMonth = month ? trips.filter((t) => dateKey(t.startMs).startsWith(month)) : trips
  const placed = placeShifts(inMonth)
  return assemblePlan(name, month, placed.chains, placed.skipped)
}

/**
 * Wie planDriver, aber die Schichten entstehen rein über große Lücken: jede
 * Fahrten-Gruppe (getrennt durch eine Lücke größer als gapThresholdH Stunden)
 * wird EINE eigene Schicht – von der ersten bis zur letzten Fahrt der Gruppe.
 * Es werden KEINE Fahrten als „nicht im Plan" verworfen. Passend für Fahrlygo,
 * wo ein Fahrer am selben Tag mehrere Schichten fährt (z. B. früh und abends).
 */
export function planDriverByGaps(name: string, trips: Trip[], gapThresholdH: number): DriverPlan {
  const month = majorityMonth(trips)
  const inMonth = month ? trips.filter((t) => dateKey(t.startMs).startsWith(month)) : trips
  const sorted = inMonth
    .filter((t) => t.endMs > t.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const chains: Trip[][] = []
  let cur: Trip[] = []
  let curEnd = 0
  for (const t of sorted) {
    if (cur.length === 0) { cur = [t]; curEnd = t.endMs; continue }
    const gapH = (t.startMs - curEnd) / H
    if (gapH > gapThresholdH) { chains.push(cur); cur = [t]; curEnd = t.endMs }
    else { cur.push(t); if (t.endMs > curEnd) curEnd = t.endMs }
  }
  if (cur.length) chains.push(cur)
  return assemblePlan(name, month, chains, [])
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let q = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++ } else q = false
      } else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row) }
  return rows
}

function col(header: string[], ...names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase())
    if (i >= 0) return i
  }
  return -1
}

/** Name vereinheitlichen – NUR für einen sicheren, EXAKTEN Dublettenschlüssel
 *  (Kleinschreibung, Umlaute/Akzente weg, Leerraum normiert). Keine Fuzzy-
 *  Logik: „Syuleyman Sali Nasuf" und „SyuleymanDUP NasufDUP" bleiben getrennt. */
export function normName(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Mögliche – aber NICHT sicher gleiche – Doppel-Fahrer finden (nur Warnung,
 * kein automatisches Zusammenführen). Verdacht, wenn Vor- und Nachname-Anfang
 * stark übereinstimmen (z. B. „Nasuf" ↔ „NasufDUP"), die Namen aber nicht exakt
 * gleich sind. Bewusst konservativ, damit echte verschiedene Fahrer („Ahmad …"
 * vs „Mohammad …") nicht fälschlich als Dublette gemeldet werden.
 */
/** Verdachts-Paare als Namenspaare (für den manuellen „Zusammenführen"-Knopf). */
export function findeDoppelPaare(names: string[]): [string, string][] {
  const prefixLen = (a: string, b: string): number => {
    let k = 0
    while (k < a.length && k < b.length && a[k] === b[k]) k++
    return k
  }
  const items = names.map((n) => ({ n, t: normName(n).split(' ').filter(Boolean) }))
  const paare: [string, string][] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j]
      if (a.t.length === 0 || b.t.length === 0) continue
      if (normName(a.n) === normName(b.n)) continue // exakt gleich → wird ohnehin gemergt
      const first = prefixLen(a.t[0], b.t[0]) >= 4
      const last = prefixLen(a.t[a.t.length - 1], b.t[b.t.length - 1]) >= 4
      if (first && last) paare.push([a.n, b.n])
    }
  }
  return paare
}

export function findeDoppelVerdacht(names: string[]): string[] {
  return findeDoppelPaare(names).map(([a, b]) => `Möglicher Doppel-Fahrer: „${a}" und „${b}" – zur Sicherheit NICHT automatisch zusammengeführt. Bitte prüfen oder zusammenführen.`)
}

/**
 * Vom Büro bestätigte Zusammenführungen anwenden: jede Gruppe von Fahrernamen
 * wird zu EINEM Fahrer (die Fahrten werden zusammengelegt, der erste vorhandene
 * Name bleibt). Nur Namen, die wirklich vorkommen, werden berührt.
 */
export function applyMerges(drivers: Map<string, Trip[]>, groups: string[][]): Map<string, Trip[]> {
  const out = new Map(drivers)
  for (const group of groups) {
    const present = group.filter((n) => out.has(n))
    if (present.length < 2) continue
    const keep = present[0]
    const trips = [...(out.get(keep) || [])]
    for (const n of present.slice(1)) { trips.push(...(out.get(n) || [])); out.delete(n) }
    out.set(keep, trips)
  }
  return out
}

/**
 * Fahrten je Fahrer. Zusammengeführt wird NUR, wenn es sicher derselbe Fahrer
 * ist: entweder gleiche Fahrer-ID aus der CSV (falls die Liste eine ID-Spalte
 * hat) oder exakt derselbe (normalisierte) Name. Zwei verschiedene Fahrer mit
 * gleichem Namen (unterschiedliche ID) bleiben getrennt und werden im
 * Anzeigenamen unterscheidbar gemacht (" (2)").
 */
export function readTripsFromCsv(csvTexts: string[]): Map<string, Trip[]> {
  // key (ID oder normalisierter Name) → fester Anzeigename + Fahrten
  const byKey = new Map<string, { name: string; trips: Trip[] }>()
  for (const text of csvTexts) {
    const rows = parseCsv(text)
    if (!rows.length) continue
    const header = rows[0]
    const vor = col(header, 'Vorname des Fahrers')
    const nach = col(header, 'Nachname des Fahrers')
    const request = col(header, 'Zeitpunkt der Fahrtbestellung')
    const dropoff = col(header, 'Ankunftszeit der Fahrt')
    const start = col(header, 'Startzeit der Fahrt')
    const status = col(header, 'Fahrtstatus')
    // Eindeutige Fahrer-Kennung, falls die Uber-Liste eine hat (NICHT die
    // Fahrt-UUID). Ist sie da, ist der Merge hundertprozentig sicher.
    const fahrerId = col(header, 'UUID des Fahrers', 'Fahrer-UUID', 'Fahrer UUID', 'Driver UUID', 'Fahrer-ID', 'Fahrer ID', 'Fahrernummer')
    if (request < 0 || dropoff < 0) continue
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length < 3) continue
      if (status >= 0 && (r[status] || '').trim().toLowerCase() !== 'completed') continue
      const end = parseWall(r[dropoff] || '')
      const begin = parseWall(r[request] || '') ?? (start >= 0 ? parseWall(r[start] || '') : null)
      if (begin == null || end == null || end <= begin) continue
      const name = `${(r[vor] || '').trim()} ${(r[nach] || '').trim()}`.trim() || 'Unbekannt'
      const id = fahrerId >= 0 ? (r[fahrerId] || '').trim() : ''
      const key = id || normName(name) || 'unbekannt'
      const e = byKey.get(key)
      const trip = { startMs: begin, endMs: end }
      if (e) e.trips.push(trip)
      else byKey.set(key, { name, trips: [trip] })
    }
  }

  // In eine Map nach Anzeigename überführen. Kollidieren zwei VERSCHIEDENE
  // Schlüssel auf denselben Namen (zwei echte Fahrer, gleicher Name), bleiben
  // sie getrennt – der zweite bekommt „ (2)".
  const out = new Map<string, Trip[]>()
  const zaehler = new Map<string, number>()
  for (const { name, trips } of byKey.values()) {
    let disp = name
    if (out.has(disp)) {
      const n = (zaehler.get(name) ?? 1) + 1
      zaehler.set(name, n)
      disp = `${name} (${n})`
    }
    out.set(disp, trips)
  }
  return out
}

export function buildPlansFromCsv(csvTexts: string[], merges: string[][] = []): DriverPlan[] {
  const drivers = applyMerges(readTripsFromCsv(csvTexts), merges)
  return [...drivers.entries()]
    .map(([name, trips]) => planDriver(name, trips))
    .filter((p) => p.days.some((d) => d.kind === 'schicht'))
    .sort((a, b) => b.paidH - a.paidH || a.name.localeCompare(b.name, 'de'))
}
