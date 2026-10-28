// Uber-/Fahrlygo-Plan auf Monats-Zielstunden bringen.
//
// Ausgangslage: Aus der Fahrtliste steht fest, an WELCHEN Tagen der Fahrer
// wirklich gefahren ist und ungefähr WANN (Startzeit je Tag). Der Büro-Nutzer
// gibt aber die Monatszahlen aus der Lohnabrechnung vor: „Gesamt" (bezahlte
// Arbeitszeit OHNE Pause) und davon „Sonntag".
//
// Dieser Planer behält die echten Arbeitstage und Startzeiten und passt nur die
// LÄNGE jeder Schicht an – proportional zur tatsächlich gefahrenen Länge –, bis
// der Monat die Vorgaben EXAKT trifft:
//   • Σ Netto (ohne Pause) = Gesamt (minutengenau)
//   • Σ Netto an Sonntagen = Sonntag
//   • je Tag höchstens 8 h netto, Pause nach § 4 ArbZG (ab >6 h 30 min, >9 h 45)
//   • Reihenfolge/Startzeiten bleiben; die Ruhezeit zur Vorschicht wird neu
//     berechnet und, falls unter 11 h, als Hinweis vermerkt (nicht erzwungen).
//
// Reines Modul (keine IO) – unit-testbar.

import { dateKey, weekdayIndex, type DriverPlan, type PlanDay, type PlanShift } from './uberPlan'

const MAX_NET_MIN = 8 * 60
const MAX_PAUSE_MIN = 90 // 1,5 h – betriebliche Obergrenze (wie im Uber-Pfad)
const H = 3600000

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export type ZielVorgabe = {
  /** Bezahlte Arbeitszeit des Monats OHNE Pause (Stunden). */
  gesamt: number
  /** Davon an Sonntagen (Stunden). */
  sonntag: number
}

/** Gesetzliches Minimum (Minuten) für eine Netto-Arbeitszeit nach § 4 ArbZG. */
function gesetzMin(netMin: number): number {
  if (netMin > 9 * 60) return 45
  if (netMin > 6 * 60) return 30
  return 0
}

/**
 * Pausenlänge: die ECHTE Lücke des Tages, aber mindestens das gesetzliche
 * Minimum und höchstens 1,5 h. Nur die Länge zählt (die genaue Uhrzeit der
 * Pause legen wir nicht fest). Im Ziel-Modus ändert die Pause den LOHN nicht –
 * die bezahlte Zeit (Netto) steht ja fest –, nur das Von–Bis-Fenster.
 */
function pausenMin(netMin: number, echteLueckeMin: number): number {
  const minimum = gesetzMin(netMin)
  return Math.min(MAX_PAUSE_MIN, Math.max(minimum, Math.round(echteLueckeMin)))
}

/**
 * Verteilt `zielMin` proportional zu den echten Längen `reals` (Minuten), je
 * Tag höchstens `maxMin`, Summe am Ende EXAKT `zielMin` (sofern das Budget
 * reicht). Gibt die Minuten je Tag und die nicht unterbringbare Restmenge.
 */
export function skaliere(reals: number[], zielMin: number, maxMin = MAX_NET_MIN): { vals: number[]; fehlt: number } {
  const n = reals.length
  if (n === 0) return { vals: [], fehlt: Math.max(0, zielMin) }
  if (zielMin <= 0) return { vals: new Array(n).fill(0), fehlt: 0 }

  const sumR = reals.reduce((a, b) => a + b, 0) || n // alle 0 → gleichmäßig
  const basis = reals.map((r) => (r > 0 ? r : sumR / n))
  const sumB = basis.reduce((a, b) => a + b, 0)
  let vals = basis.map((b) => Math.min(maxMin, (zielMin * b) / sumB))

  // Iterativ exakt treffen – überlaufende Tage sind bei maxMin gedeckelt,
  // der Rest wandert auf Tage mit Luft.
  for (let it = 0; it < 200; it++) {
    const s = vals.reduce((a, b) => a + b, 0)
    const diff = zielMin - s
    if (Math.abs(diff) < 0.5) break
    const room = vals.map((v) => (diff > 0 ? maxMin - v : v))
    const tot = room.reduce((a, b) => a + b, 0)
    if (tot < 0.5) break
    vals = vals.map((v, i) => Math.max(0, Math.min(maxMin, v + diff * (room[i] / tot))))
  }

  // Auf ganze Minuten runden und den Rundungsrest exakt ausgleichen.
  vals = vals.map((v) => Math.round(v))
  let rest = zielMin - vals.reduce((a, b) => a + b, 0)
  for (let i = 0; i < n && rest !== 0; i++) {
    const step = rest > 0 ? 1 : -1
    const nv = vals[i] + step
    if (nv >= 0 && nv <= maxMin) { vals[i] = nv; rest -= step }
  }
  // Falls der erste Durchlauf den Rest nicht ganz unterbringen konnte, weiter
  // reihum verteilen, bis entweder 0 oder kein Tag mehr Luft hat.
  let guard = 0
  while (rest !== 0 && guard++ < n * 4) {
    let moved = false
    for (let i = 0; i < n && rest !== 0; i++) {
      const step = rest > 0 ? 1 : -1
      const nv = vals[i] + step
      if (nv >= 0 && nv <= maxMin) { vals[i] = nv; rest -= step; moved = true }
    }
    if (!moved) break
  }
  const fehlt = Math.max(0, zielMin - vals.reduce((a, b) => a + b, 0))
  return { vals, fehlt }
}

/** Baut aus Tag + echter Startzeit (ms) + Netto-Minuten eine Schicht. */
function baueSchicht(startMs: number, netMin: number, echteLueckeMin: number, restH: number | null): PlanShift {
  const pMin = pausenMin(netMin, echteLueckeMin)
  const spanMin = netMin + pMin
  const endMs = startMs + spanMin * 60000
  const s = new Date(startMs)
  const e = new Date(endMs)
  const startMin = s.getUTCHours() * 60 + s.getUTCMinutes()
  let endMin = e.getUTCHours() * 60 + e.getUTCMinutes()
  const dayDiff = Math.round((Date.parse(dateKey(endMs) + 'T00:00:00Z') - Date.parse(dateKey(startMs) + 'T00:00:00Z')) / 86400000)
  endMin += dayDiff * 1440
  let pauseAt: { start: number; end: number }[] = []
  if (pMin > 0) {
    let start = Math.round((spanMin - pMin) / 2)
    if (start < 0) start = 0
    if (start + pMin > spanMin) start = spanMin - pMin
    pauseAt = [{ start, end: start + pMin }]
  }
  const notes: string[] = []
  if (restH != null && restH + 1e-6 < 11) notes.push(`Ruhezeit ${restH.toFixed(2).replace('.', ',')} h, unter 11 h`)
  return {
    date: dateKey(startMs),
    startMs,
    endMs,
    startMin,
    endMin,
    pauseH: round2(pMin / 60),
    pauseAt,
    paidH: round2(spanMin / 60),
    nettoH: round2(netMin / 60),
    restH: restH == null ? null : round2(restH),
    hinweis: notes.join(' · '),
  }
}

/**
 * Bringt einen Fahrer-Plan auf die Monats-Zielstunden (siehe Kopf). Gibt einen
 * neuen Plan zurück (gleiche Tage, angepasste Längen) plus Warnungen.
 */
export function planAnZiel(plan: DriverPlan, ziel: ZielVorgabe): DriverPlan {
  const gesamtMin = Math.round(Math.max(0, ziel.gesamt) * 60)
  let sonntagMin = Math.round(Math.max(0, ziel.sonntag) * 60)
  const warnungen: string[] = []
  if (sonntagMin > gesamtMin) {
    warnungen.push(`Sonntag (${ziel.sonntag} h) ist größer als Gesamt (${ziel.gesamt} h) – Sonntag auf Gesamt begrenzt.`)
    sonntagMin = gesamtMin
  }

  // Echte Arbeitstage mit Anker-Startzeit (frühester Start des Tages) und
  // tatsächlich gefahrener Netto-Länge als Verteilungsgewicht.
  type Anker = { tag: PlanDay; startMs: number; realNet: number; sonntag: boolean }
  const anker: Anker[] = []
  for (const tag of plan.days) {
    if (tag.kind !== 'schicht' || tag.shifts.length === 0) continue
    const startMs = Math.min(...tag.shifts.map((s) => s.startMs))
    const realNet = tag.shifts.reduce((a, s) => a + s.nettoH, 0) * 60
    anker.push({ tag, startMs, realNet, sonntag: weekdayIndex(tag.date) === 0 })
  }

  const sonntage = anker.filter((a) => a.sonntag)
  const werktage = anker.filter((a) => !a.sonntag)

  // 1) Sonntag so weit wie möglich auf die ECHTEN Sonntage legen.
  const so = skaliere(sonntage.map((a) => a.realNet), sonntagMin)
  const sonntagPlatziert = so.vals.reduce((a, b) => a + b, 0)
  if (sonntagMin > 0 && sonntage.length === 0) {
    warnungen.push(`Sonntag ${ziel.sonntag} h vorgegeben, aber der Fahrer ist an keinem Sonntag gefahren – die Stunden liegen auf Werktagen, Gesamt bleibt exakt.`)
  } else if (so.fehlt > 1) {
    warnungen.push(`Sonntag: nur ${round2(sonntagPlatziert / 60)} von ${ziel.sonntag} h möglich (${sonntage.length} Sonntag(e) gefahren, max. 8 h/Tag) – der Rest liegt auf Werktagen, Gesamt bleibt exakt.`)
  }

  // 2) Werktage füllen den REST zum Gesamtziel auf (also inkl. des Sonntag-
  //    Fehlbetrags). So trifft die Monatssumme in jedem Fall exakt das Gesamt.
  const werktagZiel = Math.max(0, gesamtMin - sonntagPlatziert)
  const rest = skaliere(werktage.map((a) => a.realNet), werktagZiel)
  if (rest.fehlt > 1) warnungen.push(`${round2(rest.fehlt / 60)} h passen nicht auf die ${werktage.length} echten Werktage (max. 8 h/Tag) – Gesamt wird nicht ganz erreicht.`)

  const netById = new Map<string, number>()
  sonntage.forEach((a, i) => netById.set(a.tag.date, so.vals[i]))
  werktage.forEach((a, i) => netById.set(a.tag.date, rest.vals[i]))

  // Neuen Plan bauen: echte Tage behalten, Längen aus der Verteilung.
  let prevEndMs: number | null = null
  let paidH = 0
  let nettoH = 0
  let workDays = 0
  const neueTage: PlanDay[] = plan.days.map((tag) => {
    if (tag.kind !== 'schicht' || tag.shifts.length === 0) return tag
    const netMin = netById.get(tag.date) ?? 0
    if (netMin <= 0) {
      return { ...tag, kind: 'frei', shifts: [], hinweis: 'durch Zielvorgabe nicht belegt', ausgelassen: '' }
    }
    const startMs = Math.min(...tag.shifts.map((s) => s.startMs))
    const realPause = Math.max(0, ...tag.shifts.map((s) => s.pauseH)) * 60
    const restH = prevEndMs != null ? (startMs - prevEndMs) / H : null
    const shift = baueSchicht(startMs, netMin, realPause, restH)
    prevEndMs = shift.endMs
    paidH += shift.paidH
    nettoH += shift.nettoH
    workDays++
    return { ...tag, shifts: [shift], hinweis: shift.hinweis, ausgelassen: '' }
  })

  const weekNotes = [...plan.weekNotes]
  if (warnungen.length) weekNotes.unshift(...warnungen)

  return {
    ...plan,
    days: neueTage,
    paidH: round2(paidH),
    nettoH: round2(nettoH),
    workDays,
    freeDays: neueTage.filter((d) => d.kind !== 'schicht').length,
    weekNotes,
  }
}
