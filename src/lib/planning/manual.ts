// Schichtplan aus den Monatsstunden.
//
// Der Nutzer gibt nur die Summen des Monats: Gesamt (bezahlt), Sonntag,
// Nacht 40 % und Nacht 25 %. `erstellePlan` legt die Tage fest und setzt
// Start, Pause und Ende. Keine Uhrzeit kommt vom Nutzer.
//
// Dieselben Regeln wie in wage.ts / exact.ts:
//   • Bezahlt = Spanne Beginn→Ende. Die Pause ist bezahlt und bleibt drin.
//   • Netto = Spanne minus Pause. Zuschläge laufen nur auf diese Arbeitszeit.
//   • Pause: bis 4 Std Spanne keine; darüber 30 Min, ab mehr als 9 Std Netto 45.
//   • Ruhezeit zur Vorschicht mindestens 11 Std (§ 5 ArbZG). Darunter Warnung.
//   • Nacht 25 %: 04–06 und 20–24 Uhr. Nacht 40 %: 00–04 Uhr. Sonntag 50 %.
//   • Nachtschicht beginnt abends, nie um 00:00. Start, Ende und Länge
//     streuen (fester Keim aus Monat und Vorgaben, Bildschirm = Excel).
//     Die Summen bleiben minutengenau. Erfundene Zuschlagsstunden gibt es nicht.
//   • Höchstens 2 freie Tage je Woche, wenn dabei mindestens 3 Std/Tag möglich sind.
//
// `berechneManuell` bleibt für eine ältere Tagesliste (Fenster + Bezahlt-Stunden).
// Der Bildschirm schickt diese Liste nicht mehr.

import { requiredBreakMinutes } from './breaks'
import { minToClock } from './format'
import { computeShiftHours } from './wage'

export type DayInput = {
  date: string // YYYY-MM-DD
  aktiv: boolean
  /** Fensterbeginn "HH:MM". Leer = noch nicht gesetzt. */
  von: string
  /** Fensterende "HH:MM". Liegt es auf oder vor Von, läuft das Fenster über Mitternacht. */
  bis: string
  /** Bezahlte Stunden, die an diesem Tag in das Fenster gelegt werden sollen. */
  bezahlt: number
}

export type DayResult = {
  date: string
  aktiv: boolean
  von: string
  bis: string
  startMin: number | null
  endMin: number | null
  start: string | null
  ende: string | null
  /** true, wenn das Ende auf den Folgetag fällt. */
  overnight: boolean
  pause: number
  breaks: { start: number; end: number }[]
  /** Tatsächliche Spanne. Kann kürzer als die Eingabe sein, wenn das Fenster nicht reicht. */
  bezahlt: number
  netto: number
  ruhe: number | null
  n25: number
  n40: number
  so: number
  warnung: string | null
}

export type ManualResult = {
  tage: DayResult[]
  warnings: string[]
  summe: {
    netto: number
    bezahlt: number
    n25: number
    n40: number
    so: number
    minRuhe: number | null
    ruheVerletzt: boolean
  }
}

export type VorschlagZiel = { bezahlt: number; sunday: number; n25: number; n40: number }
export type VorschlagTag = { date: string; von: string; bis: string; bezahlt: number }
export type Vorschlag = { tage: VorschlagTag[]; warnings: string[] }

const MIN_REST_MS = 11 * 3600000
const MAX_NET_MIN = 8 * 60
const MIN_PAID_MIN = 3 * 60
const MAX_PAID_MIN = MAX_NET_MIN + 30 // 8 Std Netto + 30 Min Pause
const TAG_VON = '06:00'
const TAG_BIS = '19:00'
const NACHT_VON = '20:00'
const NACHT_BIS = '06:00'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** "HH:MM" → Minuten seit Mitternacht. 24:00 ist erlaubt, alles darüber nicht. */
export function clockToMin(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

/**
 * Pause aus der bezahlten Spanne. Bis 4 Std keine Pause. Darüber 30 Min,
 * und 45 Min, sobald 30 Min die Nettozeit noch über 9 Std lassen würden
 * (§ 4 ArbZG: über 9 Std Netto mindestens 45). Niemals länger als die Spanne.
 */
export function pauseUndNetto(spanMin: number): { pause: number; nettoMin: number } {
  if (spanMin <= 4 * 60) return { pause: 0, nettoMin: Math.max(0, spanMin) }
  let pause = 30
  if ((spanMin - pause) / 60 > 9) pause = 45
  pause = Math.max(pause, requiredBreakMinutes((spanMin - pause) / 60))
  if (pause >= spanMin || pause > 120) pause = Math.min(120, Math.max(0, spanMin - 1))
  if (pause >= spanMin) return { pause: 0, nettoMin: spanMin }
  return { pause, nettoMin: spanMin - pause }
}

/** Bezahlte Spanne, die eine gewünschte Nettozeit inklusive passender Pause ergibt. */
function spanFuerNetto(nettoMin: number): number {
  if (nettoMin <= 0) return 0
  if (nettoMin < 4 * 60) return nettoMin
  if (nettoMin > 9 * 60) return nettoMin + 45
  return nettoMin + 30
}

function monthDays(year: number, month1: number): { iso: string; dow: number }[] {
  const out: { iso: string; dow: number }[] = []
  const d = new Date(year, month1 - 1, 1)
  while (d.getMonth() === month1 - 1) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ iso, dow: d.getDay() })
    d.setDate(d.getDate() + 1)
  }
  return out
}

function shiftIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + delta)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function mondayKey(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const off = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - off)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function dayStartMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** Fenster in Minuten ab Mitternacht des Tages. Ende kann über 1440 liegen. */
function fensterMinuten(von: string, bis: string): { start: number; end: number } | null {
  const a = clockToMin(von)
  const b0 = clockToMin(bis)
  if (a == null || b0 == null) return null
  const end = b0 <= a ? b0 + 1440 : b0
  if (end <= a) return null
  return { start: a, end }
}

function leerTag(input: DayInput): DayResult {
  return {
    date: input.date, aktiv: false, von: input.von, bis: input.bis,
    startMin: null, endMin: null, start: null, ende: null, overnight: false,
    pause: 0, breaks: [], bezahlt: 0, netto: 0, ruhe: null, n25: 0, n40: 0, so: 0,
    warnung: null,
  }
}

/**
 * Legt die bezahlte Spanne in das Fenster. Start so früh wie möglich, aber
 * nicht vor dem Ende der Vorschicht plus 11 Std. Passt das nicht, bleibt die
 * Schicht im Fenster und die Ruhezeit wird als verletzt gemeldet.
 */
export function berechneManuell(days: DayInput[]): ManualResult {
  const byDate = new Map<string, DayInput>()
  for (const d of days) {
    if (!d?.date || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue
    byDate.set(d.date, d)
  }
  const ordered = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))

  const tage: DayResult[] = []
  const warnings: string[] = []
  let prevEndMs: number | null = null
  let ruheVerletzungen = 0

  for (const input of ordered) {
    const bezahltEingabe = Number(input.bezahlt) || 0
    if (!input.aktiv || bezahltEingabe <= 0) {
      tage.push(leerTag(input))
      continue
    }

    const fenster = fensterMinuten(input.von, input.bis)
    if (!fenster) {
      const zeile = leerTag({ ...input, aktiv: true })
      zeile.warnung = 'Fenster Von–Bis fehlt oder ist ungültig.'
      tage.push(zeile)
      warnings.push(`${input.date}: ${zeile.warnung}`)
      continue
    }

    const hinweise: string[] = []
    let span = Math.round(bezahltEingabe * 60)
    const laenge = fenster.end - fenster.start
    if (span > laenge) {
      span = laenge
      hinweise.push('Fenster kürzer als die Bezahlt-Stunden – Schicht auf das Fenster gekürzt.')
    }
    if (span <= 0) {
      tage.push(leerTag(input))
      continue
    }

    const latest = fenster.end - span
    let start = fenster.start
    if (prevEndMs != null) {
      const fruehestens = Math.ceil((prevEndMs + MIN_REST_MS - dayStartMs(input.date)) / 60000)
      if (fruehestens > start) start = fruehestens
    }
    if (start > latest) {
      start = Math.max(fenster.start, latest)
      hinweise.push('Ruhezeit unter 11 Std – im Fenster nicht anders unterzubringen.')
    }
    const end = start + span
    const { pause, nettoMin } = pauseUndNetto(span)
    const half = Math.round(nettoMin / 2)
    const breaks = pause > 0 ? [{ start: half, end: half + pause }] : []
    const startMs = dayStartMs(input.date) + start * 60000
    const endMs = dayStartMs(input.date) + end * 60000
    const ruhe = prevEndMs != null ? round2((startMs - prevEndMs) / 3600000) : null
    if (ruhe != null && ruhe < 11) ruheVerletzungen++
    if (nettoMin / 60 > 8 + 1e-6) hinweise.push('Mehr als 8 Netto-Stunden an diesem Tag.')

    const stunden = computeShiftHours({ date: input.date, startMin: start, endMin: end, breaks })
    prevEndMs = endMs
    const warnung = hinweise.length ? hinweise.join(' ') : null
    if (warnung) warnings.push(`${input.date}: ${warnung}`)
    tage.push({
      date: input.date, aktiv: true, von: input.von, bis: input.bis,
      startMin: start, endMin: end,
      start: minToClock(start), ende: minToClock(end), overnight: end >= 1440,
      pause, breaks,
      bezahlt: round2(span / 60), netto: round2(nettoMin / 60),
      ruhe, n25: round2(stunden.night25), n40: round2(stunden.night40), so: round2(stunden.sunday50),
      warnung,
    })
  }

  const sum = (sel: (t: DayResult) => number) => round2(tage.reduce((a, t) => a + sel(t), 0))
  const ruhen = tage.map((t) => t.ruhe).filter((v): v is number => v != null)
  const minRuhe = ruhen.length ? Math.min(...ruhen) : null
  if (ruheVerletzungen > 0) {
    warnings.unshift(`Ruhezeit unter 11 Std an ${ruheVerletzungen} Tag(en).`)
  }
  return {
    tage,
    warnings,
    summe: {
      netto: sum((t) => t.netto), bezahlt: sum((t) => t.bezahlt),
      n25: sum((t) => t.n25), n40: sum((t) => t.n40), so: sum((t) => t.so),
      minRuhe, ruheVerletzt: minRuhe != null && minRuhe < 11,
    },
  }
}

type Platziert = { date: string; von: string; bis: string; spanMin: number; nettoMin: number; nacht: boolean }

/**
 * Füllt ein Netto-Ziel in möglichst volle Schichten (bis 8 Std), solange das
 * bezahlte Monatsbudget reicht. „Sättigen" = ein Tag wird voll gemacht, bevor
 * der nächste beginnt.
 */
function saettigen(
  tage: string[],
  nettoZielMin: number,
  paidBudgetMin: number,
  von: string,
  bis: string,
  nacht: boolean,
): { platziert: Platziert[]; nettoOffen: number; paidRest: number } {
  let nettoOffen = Math.max(0, Math.round(nettoZielMin))
  let paidRest = Math.max(0, Math.round(paidBudgetMin))
  const platziert: Platziert[] = []
  for (const date of tage) {
    if (nettoOffen <= 0 || paidRest <= 0) break
    let netto = Math.min(MAX_NET_MIN, nettoOffen)
    let span = spanFuerNetto(netto)
    if (span > paidRest) {
      span = paidRest
      netto = pauseUndNetto(span).nettoMin
      if (netto <= 0) break
    }
    platziert.push({ date, von, bis, spanMin: span, nettoMin: netto, nacht })
    nettoOffen -= netto
    paidRest -= span
  }
  return { platziert, nettoOffen, paidRest }
}

function dowOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** Gleichmäßig verteilte Indizes, ohne Doppelte. */
function pickEven(dates: string[], count: number): string[] {
  if (count <= 0 || dates.length === 0) return []
  if (count >= dates.length) return [...dates]
  const chosen = new Set<number>()
  for (let i = 0; i < count; i++) {
    let idx = Math.round((i * (dates.length - 1)) / Math.max(1, count - 1))
    if (chosen.has(idx)) {
      for (let delta = 1; delta < dates.length; delta++) {
        if (idx + delta < dates.length && !chosen.has(idx + delta)) { idx += delta; break }
        if (idx - delta >= 0 && !chosen.has(idx - delta)) { idx -= delta; break }
      }
    }
    chosen.add(idx)
  }
  return [...chosen].sort((a, b) => a - b).map((i) => dates[i])
}

/** Erst Werktage füllen, Sonntage nur wenn sonst nicht genug Tage da sind. */
function nimmTage(wochentage: string[], sonntage: string[], count: number): string[] {
  if (count <= wochentage.length) return pickEven(wochentage, count)
  return [...wochentage, ...pickEven(sonntage, count - wochentage.length)]
}

/**
 * Optionaler Vorschlag. Reihenfolge:
 * 1. Sonntagsstunden auf Sonntage, ein Tag nach dem anderen voll (max. 8 Netto).
 * 2. Nachtstunden auf Mo–Fr, zuerst Freitage, ebenfalls voll. Der Folgetag
 *    bleibt frei, damit die 11-Std-Ruhe nicht in eine Frühschicht läuft.
 * 3. Restliche Bezahlt-Stunden auf die übrigen Tage.
 * 4. Höchstens 2 freie Tage je Woche, wenn dabei mindestens 3 Std/Tag möglich sind.
 * 5. Bei zu wenig Stunden (z. B. 30 Std auf viele Tage) gleichmäßig auf so viele
 *    Tage, dass jeder mindestens 3 Std bekommt.
 */
export function schlageVor(year: number, month1: number, ziel: VorschlagZiel): Vorschlag {
  const warnings: string[] = []
  const bezahltMin = Math.round(Math.max(0, ziel.bezahlt) * 60)
  if (bezahltMin <= 0) return { tage: [], warnings: ['Keine Bezahlt-Stunden vorgegeben.'] }

  const kalender = monthDays(year, month1)
  const sonntage = kalender.filter((t) => t.dow === 0).map((t) => t.iso)
  // Nacht nur Mo–Fr. Ein Samstag würde in den Sonntag laufen und die
  // Sonntagssumme mit Nachtstunden vermischen.
  const nachtTage = [
    ...kalender.filter((t) => t.dow === 5).map((t) => t.iso),
    ...kalender.filter((t) => t.dow >= 1 && t.dow <= 4).map((t) => t.iso),
  ]

  const sonntag = saettigen(sonntage, Math.max(0, ziel.sunday) * 60, bezahltMin, TAG_VON, TAG_BIS, false)
  if (sonntag.nettoOffen > 1) {
    warnings.push(`Sonntag: ${round2(sonntag.nettoOffen / 60)} Std konnten nicht untergebracht werden (max. 8 Netto-Std je Sonntag, oder das Bezahlt-Budget reicht nicht).`)
  }

  const nachtZiel = Math.max(0, (Number(ziel.n25) || 0) + (Number(ziel.n40) || 0)) * 60
  const nacht = saettigen(nachtTage, nachtZiel, sonntag.paidRest, NACHT_VON, NACHT_BIS, true)
  if (nacht.nettoOffen > 1) {
    warnings.push(`Nacht: ${round2(nacht.nettoOffen / 60)} Std konnten nicht untergebracht werden.`)
  }

  const platziert = new Map<string, Platziert>()
  for (const p of [...sonntag.platziert, ...nacht.platziert]) platziert.set(p.date, p)

  const gesperrt = new Set<string>()
  for (const p of nacht.platziert) gesperrt.add(shiftIso(p.date, 1))

  const restMin = nacht.paidRest
  const pool = kalender
    .map((t) => t.iso)
    .filter((iso) => !platziert.has(iso) && !gesperrt.has(iso))

  if (restMin > 0 && pool.length === 0) {
    warnings.push(`${round2(restMin / 60)} Bezahlt-Std bleiben übrig – kein freier Tag mehr im Monat.`)
  }

  const wochen = new Map<string, string[]>()
  for (const iso of pool) {
    const key = mondayKey(iso)
    wochen.set(key, [...(wochen.get(key) ?? []), iso])
  }

  const tageImMonat = new Map<string, number>()
  const schonGearbeitet = new Map<string, number>()
  for (const t of kalender) {
    const key = mondayKey(t.iso)
    tageImMonat.set(key, (tageImMonat.get(key) ?? 0) + 1)
    if (platziert.has(t.iso)) schonGearbeitet.set(key, (schonGearbeitet.get(key) ?? 0) + 1)
  }

  let minExtra = 0
  const minJeWoche = new Map<string, number>()
  for (const [key, dates] of wochen) {
    const freiOhneWeitere = (tageImMonat.get(key) ?? 0) - (schonGearbeitet.get(key) ?? 0)
    const nochNoetig = Math.max(0, freiOhneWeitere - 2)
    const n = Math.min(nochNoetig, dates.length)
    minJeWoche.set(key, n)
    minExtra += n
  }
  const dreiStundenMoeglich = restMin >= minExtra * MIN_PAID_MIN

  let gewaehlt: string[] = []
  if (restMin > 0 && pool.length > 0) {
    const nonSun = pool.filter((iso) => dowOf(iso) !== 0)
    const sunLeft = pool.filter((iso) => dowOf(iso) === 0)

    if (!dreiStundenMoeglich) {
      const count = restMin < MIN_PAID_MIN
        ? 1
        : Math.min(nonSun.length + sunLeft.length, Math.floor(restMin / MIN_PAID_MIN))
      gewaehlt = nimmTage(nonSun, sunLeft, Math.max(1, count))
      warnings.push('Zu wenig Stunden für höchstens 2 freie Tage je Woche bei mind. 3 Std/Tag – die Stunden sind gleichmäßig auf weniger Tage verteilt.')
    } else {
      const vorgewaehlt: string[] = []
      for (const [key, dates] of [...wochen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const ohneSonntag = dates.filter((iso) => dowOf(iso) !== 0)
        const quelle = ohneSonntag.length >= (minJeWoche.get(key) ?? 0) ? ohneSonntag : [...dates].sort()
        vorgewaehlt.push(...pickEven([...quelle].sort(), minJeWoche.get(key) ?? 0))
      }
      const schon = new Set(vorgewaehlt)
      const restWochentage = nonSun.filter((iso) => !schon.has(iso))
      const restSonntag = sunLeft.filter((iso) => !schon.has(iso))
      const verfuegbar = restWochentage.length + restSonntag.length + vorgewaehlt.length
      let count = Math.min(verfuegbar, Math.floor(restMin / MIN_PAID_MIN))
      count = Math.max(count, vorgewaehlt.length, restMin > 0 ? 1 : 0)
      while (count < verfuegbar && count > 0 && restMin / count > MAX_PAID_MIN) count++
      const extra = nimmTage(restWochentage, restSonntag, Math.max(0, count - vorgewaehlt.length))
      gewaehlt = [...vorgewaehlt, ...extra]
    }

    const count = gewaehlt.length
    if (count > 0) {
      const obergrenze = count * MAX_PAID_MIN
      if (restMin > obergrenze) {
        const stuecke = gewaehlt.map(() => MAX_PAID_MIN)
        warnings.push(`${round2((restMin - obergrenze) / 60)} Bezahlt-Std passen nicht mehr auf die freien Tage (max. 8 Netto-Std/Tag).`)
        gewaehlt.forEach((date, i) => {
          const span = stuecke[i]
          platziert.set(date, { date, von: TAG_VON, bis: TAG_BIS, spanMin: span, nettoMin: pauseUndNetto(span).nettoMin, nacht: false })
        })
      } else {
        const basis = Math.floor(restMin / count)
        let rest = restMin - basis * count
        const stuecke = gewaehlt.map(() => {
          const span = basis + (rest > 0 ? 1 : 0)
          if (rest > 0) rest--
          return span
        })
        gewaehlt.forEach((date, i) => {
          const span = stuecke[i]
          platziert.set(date, { date, von: TAG_VON, bis: TAG_BIS, spanMin: span, nettoMin: pauseUndNetto(span).nettoMin, nacht: false })
        })
      }
    }
  }

  const freiZuViel: string[] = []
  const wochenKeys = [...new Set(kalender.map((t) => mondayKey(t.iso)))].sort()
  for (const key of wochenKeys) {
    const imMonat = kalender.filter((t) => mondayKey(t.iso) === key)
    const frei = imMonat.filter((t) => !platziert.has(t.iso)).length
    if (frei > 2) freiZuViel.push(key)
  }
  if (freiZuViel.length > 0 && dreiStundenMoeglich && restMin > 0) {
    warnings.push('Nicht in jeder Woche höchstens 2 freie Tage – die 11-Std-Ruhe oder die Sonntags-/Nachtverteilung lässt das nicht zu.')
  }

  const kurz = [...platziert.values()].filter((p) => p.spanMin < MIN_PAID_MIN).length
  if (kurz > 0) warnings.push(`${kurz} Schicht(en) unter 3 Std – die Vorgabe ist kleiner als ein voller 3-Std-Tag.`)

  const tage: VorschlagTag[] = [...platziert.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({ date: p.date, von: p.von, bis: p.bis, bezahlt: round2(p.spanMin / 60) }))

  return { tage, warnings }
}

type RohSchicht = {
  date: string
  startMin: number
  endMin: number
  pause: number
  breaks: { start: number; end: number }[]
}

/**
 * Schicht mit festem Start. `pauseMin` darf länger sein als das gesetzliche
 * Minimum (höchstens 120), nie kürzer. Ohne Angabe liegt die Pause um die
 * Mitte, auf 5 Minuten gezogen. `breakAt` ist die Lage ab Schichtbeginn.
 */
function baueSchicht(
  date: string,
  startMin: number,
  spanMin: number,
  breakAt: number | null,
  pauseMin: number | null = null,
): RohSchicht {
  const span = Math.max(0, Math.round(spanMin))
  const legal = pauseUndNetto(span).pause
  let pause = pauseMin == null ? legal : Math.max(legal, Math.round(pauseMin))
  if (pause > 120) pause = 120
  if (pause >= span) pause = legal >= span ? 0 : legal
  let off = breakAt
  if (pause <= 0) off = null
  else if (off == null) {
    const mid = Math.round((span - pause) / 2)
    off = Math.max(0, Math.min(Math.round(mid / 5) * 5, span - pause))
  } else off = Math.max(0, Math.min(Math.round(off), span - pause))
  const breaks = pause > 0 && off != null ? [{ start: off, end: off + pause }] : []
  return {
    date,
    startMin: Math.round(startMin),
    endMin: Math.round(startMin) + span,
    pause: breaks.length ? pause : 0,
    breaks,
  }
}

function stundenVon(s: RohSchicht) {
  return computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.breaks })
}

const REST_MIN = 11 * 60
/** Tagesrest endet um 19:00, damit der nächste Morgen um 06:00 noch 11 Std Ruhe hat und keine Nacht 25 % entsteht. */
const FILL_ENDE = 19 * 60

function absMin(date: string, min: number): number {
  return Math.round(dayStartMs(date) / 60000) + min
}

/** true, wenn die neue Schicht keine vorhandene schneidet und zu beiden Seiten 11 Std Ruhe lässt. */
function ruheOk(vorhanden: RohSchicht[], date: string, startMin: number, endMin: number): boolean {
  const start = absMin(date, startMin)
  const end = absMin(date, endMin)
  for (const s of vorhanden) {
    const ps = absMin(s.date, s.startMin)
    const pe = absMin(s.date, s.endMin)
    if (end <= ps) {
      if (ps - end < REST_MIN) return false
    } else if (start >= pe) {
      if (start - pe < REST_MIN) return false
    } else return false
  }
  return true
}

/**
 * Nachtschicht, die die offenen Quoten trifft und sie nicht überzieht.
 * Sicherheitsnetz, wenn die gestreute Verteilung nicht aufgeht:
 * Ist Nacht 25 % noch offen, beginnt die Schicht um 20:00 (Pause 23:30–00:00).
 * Ist Nacht 25 % voll, liegt die Arbeit nur in 00:00–04:00.
 */
function nachtEntwurf(n40: number, n25: number, paid: number): { start: number; span: number; breakAt: number | null; pause: number | null } | null {
  if (paid < 60) return null
  if (n40 > 30 && n25 >= 210) {
    const voll = n40 >= 240 && n25 >= 240 && paid >= 510
    let span = voll ? 510 : 240 + Math.min(240, n40)
    span = Math.min(span, paid)
    if (span > 240 && span >= 300) return { start: 20 * 60, span, breakAt: 210, pause: null }
  }
  if (n40 > 30) {
    if (n40 >= 240 && paid >= 270) return { start: 23 * 60 + 30, span: 270, breakAt: 0, pause: 30 }
    const span = Math.min(240, n40, paid)
    if (span >= 60) {
      const start = 4 * 60 - span
      if (start >= 15) return { start, span, breakAt: null, pause: null }
      // Volle 4 Std würden um 00:00 beginnen. Die Zeit davor wird Pause, die Arbeit bleibt nach Mitternacht.
      const pauseLen = Math.max(15, span - 225)
      if (pauseLen <= 120 && span - pauseLen >= 60 && 1440 - pauseLen >= 22 * 60) {
        return { start: 1440 - pauseLen, span, breakAt: 0, pause: pauseLen }
      }
    }
  }
  if (n25 > 30) {
    const span = Math.min(240, n25, paid)
    if (span >= 60) return { start: 20 * 60, span, breakAt: null, pause: null }
  }
  return null
}

type Fenster = { date: string; startMin: number; maxSpan: number }
type Rng = () => number
type Uhren = { starts: number[]; ends: number[]; dauern: number[] }
type Shape = { start: number; span: number; breakAt: number | null; pause: number }
type Biss = { n40: number; n25: number }

function mischkern(n: number): number {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/** Gleicher Monat und gleiche Vorgaben → gleicher Plan. Anderer Monat → andere Uhrzeiten. */
function rngAusZiel(year: number, month1: number, ziel: VorschlagZiel): Rng {
  let h = mischkern(year * 100 + month1)
  h = mischkern(h ^ mischkern(Math.round(ziel.bezahlt * 60)))
  h = mischkern(h ^ mischkern(Math.round((ziel.sunday || 0) * 60) + 17))
  h = mischkern(h ^ mischkern(Math.round((ziel.n25 || 0) * 60) + 29))
  h = mischkern(h ^ mischkern(Math.round((ziel.n40 || 0) * 60) + 47))
  let a = h || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function uhr(min: number): number {
  return ((Math.round(min) % 1440) + 1440) % 1440
}

function abstandZu(wert: number, liste: number[], kreis: boolean): number {
  if (liste.length === 0) return 240
  let best = 99999
  for (const v of liste) {
    let d = Math.abs(wert - v)
    if (kreis) d = Math.min(d, 1440 - d)
    if (d < best) best = d
  }
  return best
}

function mische<T>(liste: T[], rng: Rng): T[] {
  const arr = [...liste]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

function clampN(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Minuten auf Fenster verteilen: Summe exakt, Längen möglichst verschieden. */
function verteilUngleich(caps: number[], total: number, rng: Rng): number[] {
  const n = caps.length
  const deckel = caps.map((c) => Math.max(0, Math.round(c)))
  const spans = new Array<number>(n).fill(0)
  if (n === 0 || total <= 0) return spans
  let left = Math.min(Math.round(total), deckel.reduce((a, b) => a + b, 0))
  const mindest = left >= n * MIN_PAID_MIN ? MIN_PAID_MIN : 60

  if (mindest >= 60 && left >= n * Math.min(mindest, 60)) {
    const reihe = mische(deckel.map((_, i) => i), rng)
    for (const i of reihe) {
      const geb = Math.min(deckel[i], mindest)
      if (geb < 60 || left < geb) continue
      const restTage = reihe.filter((j) => spans[j] === 0 && j !== i && deckel[j] >= 60).length
      if (left - geb < restTage * 60 && restTage > 0) continue
      spans[i] = geb
      left -= geb
    }
  }

  const aktiv: number[] = []
  for (let i = 0; i < n; i++) if (deckel[i] > spans[i]) aktiv.push(i)
  if (aktiv.length > 0 && left > 0) {
    const perm = mische(aktiv, rng)
    const gewicht = new Map<number, number>()
    perm.forEach((idx, k) => gewicht.set(idx, 0.35 + (k / Math.max(1, perm.length - 1)) * 1.3))
    const sumW = aktiv.reduce((s, i) => s + (gewicht.get(i) ?? 1), 0)
    let used = 0
    for (let k = 0; k < aktiv.length; k++) {
      const i = aktiv[k]
      const room = deckel[i] - spans[i]
      const roh = k === aktiv.length - 1 ? left - used : Math.round(((left * (gewicht.get(i) ?? 1)) / sumW) / 5) * 5
      const add = Math.max(0, Math.min(room, left - used, roh))
      spans[i] += add
      used += add
    }
    left -= used
  }
  let rest = left
  let guard = 0
  while (rest > 0 && guard++ < rest + 2) {
    const step = rest >= 5 ? 5 : 1
    let pick = -1
    let best = -1e9
    for (let i = 0; i < n; i++) {
      if (deckel[i] - spans[i] < step) continue
      const next = spans[i] + step
      let near = 9999
      for (let j = 0; j < n; j++) {
        if (j === i || spans[j] <= 0) continue
        near = Math.min(near, Math.abs(spans[j] - next))
      }
      const fuell = next / Math.max(1, deckel[i])
      let sc = Math.min(near, 120) - fuell * 25 + rng() * 3
      if (near < 20) sc -= 70
      if (sc > best) { best = sc; pick = i }
    }
    if (pick < 0) break
    spans[pick] += step
    rest -= step
  }
  for (let i = 0; i < n; i++) {
    if (spans[i] <= 0 || spans[i] >= 60) continue
    let scrap = spans[i]
    spans[i] = 0
    for (let j = 0; j < n && scrap > 0; j++) {
      if (j === i || spans[j] < 60) continue
      const room = deckel[j] - spans[j]
      if (room <= 0) continue
      const give = Math.min(room, scrap)
      spans[j] += give
      scrap -= give
    }
    if (scrap > 0) spans[i] = scrap
  }
  const belegt = spans.filter((s) => s > 0).length
  const boden = belegt > 0 && spans.filter((s) => s >= MIN_PAID_MIN).length === belegt ? MIN_PAID_MIN : 60
  for (let pass = 0; pass < n * 3; pass++) {
    let moved = false
    for (let i = 0; i < n && !moved; i++) {
      if (spans[i] < boden) continue
      for (let j = i + 1; j < n; j++) {
        if (spans[j] < boden) continue
        const diff = Math.abs(spans[i] - spans[j])
        if (diff >= 25) continue
        const step = diff === 0 ? 20 : 15
        const geben = (from: number, to: number) => {
          if (spans[from] - step < boden) return false
          if (deckel[to] - spans[to] < step) return false
          const nf = spans[from] - step
          const nt = spans[to] + step
          if (Math.abs(nf - nt) <= diff) return false
          for (let k = 0; k < n; k++) {
            if (k === from || k === to || spans[k] < boden) continue
            if (Math.abs(spans[k] - nf) < 15 || Math.abs(spans[k] - nt) < 15) return false
          }
          spans[from] = nf
          spans[to] = nt
          return true
        }
        if (geben(i, j) || geben(j, i)) { moved = true; break }
      }
    }
    if (!moved) break
  }
  return spans
}

const MESS_TAG = '2026-10-06' // Dienstag, damit die Probe keine Sonntagsstunden zählt

function mess(shape: Shape): { n40: number; n25: number; paid: number; net: number } {
  const s = baueSchicht(MESS_TAG, shape.start, shape.span, shape.breakAt, shape.pause)
  const h = stundenVon(s)
  return {
    n40: Math.round(h.night40 * 60),
    n25: Math.round(h.night25 * 60),
    paid: s.endMin - s.startMin,
    net: Math.round(h.workedHours * 60),
  }
}

function shapePasst(shape: Shape, n40: number, n25: number, paidCap: number): boolean {
  if (shape.span <= 0 || shape.span > paidCap || shape.start < 0) return false
  if (uhr(shape.start) === 0) return false
  if (shape.pause < 0 || shape.pause > 120 || (shape.pause > 0 && shape.pause >= shape.span)) return false
  const m = mess(shape)
  if (Math.abs(m.n40 - n40) > 1 || Math.abs(m.n25 - n25) > 1) return false
  if (n25 === 0 && m.n25 > 1) return false
  if (n40 === 0 && m.n40 > 1) return false
  if (m.net > n40 + n25 + 1) return false
  if (m.net > MAX_NET_MIN + 1) return false
  if (m.paid > paidCap) return false
  return true
}

function merkeSchicht(uhren: Uhren, s: RohSchicht) {
  uhren.starts.push(uhr(s.startMin))
  uhren.ends.push(uhr(s.endMin))
  uhren.dauern.push(s.endMin - s.startMin)
}

function scoreForm(shape: Shape, uhren: Uhren): number {
  const start = uhr(shape.start)
  const end = uhr(shape.start + shape.span)
  const ds = abstandZu(start, uhren.starts, true)
  const de = abstandZu(end, uhren.ends, true)
  const dd = abstandZu(shape.span, uhren.dauern, false)
  const legal = pauseUndNetto(shape.span).pause
  const extra = Math.max(0, shape.pause - legal)
  let sc = Math.min(ds, 180) * 4 + Math.min(de, 180) * 4 + Math.min(dd, 150) * 3
  sc -= extra / 5
  if (ds < 20) sc -= 2000
  if (de < 20) sc -= 2000
  if (uhren.dauern.length > 0 && dd < 25) sc -= 800
  return sc
}

/** Alle Uhrzeiten, die genau diese Nacht-40- und Nacht-25-Minuten liefern. */
function formenFuer(n40: number, n25: number, paidCap: number): Shape[] {
  const out: Shape[] = []
  const gesehen = new Set<string>()
  const push = (shape: Shape) => {
    const key = `${shape.start}|${shape.span}|${shape.breakAt ?? '-'}|${shape.pause}`
    if (gesehen.has(key)) return
    gesehen.add(key)
    if (shapePasst(shape, n40, n25, paidCap)) out.push(shape)
  }

  if (n40 <= 0 && n25 <= 0) return out

  if (n25 <= 0 && n40 >= 15) {
    if (n40 <= 240 - 15) {
      for (let start = 15; start <= 240 - n40; start += 10) push({ start, span: n40, breakAt: null, pause: 0 })
    }
    for (let pause = 30; pause <= 120; pause += 10) {
      const start = 1440 - pause
      const span = pause + n40
      if (start < 22 * 60 || span > paidCap) continue
      if (1440 + n40 > 1680) continue
      push({ start, span, breakAt: 0, pause })
    }
    for (let workStart = 10; workStart <= 240 - n40; workStart += 10) {
      const earliest = Math.max(22 * 60, 1440 + workStart - 120)
      const latest = 1440 + workStart - 30
      for (let start = earliest; start <= latest; start += 10) {
        if (start >= 1440) continue
        const pause = 1440 + workStart - start
        const span = 1440 + workStart + n40 - start
        if (pause < 30 || pause > 120 || span > paidCap) continue
        push({ start, span, breakAt: 0, pause })
      }
    }
  }

  if (n40 <= 0 && n25 >= 15 && n25 <= 240) {
    for (let start = 20 * 60; start <= 1440 - n25; start += 10) {
      push({ start, span: n25, breakAt: null, pause: 0 })
    }
    if (n25 <= 120) {
      for (let start = 4 * 60; start <= 6 * 60 - n25; start += 10) {
        push({ start, span: n25, breakAt: null, pause: 0 })
      }
    }
  }

  if (n40 >= 15 && n25 >= 15 && n40 < 240 && n25 <= 210 && n40 + n25 <= 480) {
    if (n40 + n25 <= 240) {
      const start = 1440 - n25
      if (start >= 20 * 60) push({ start, span: n40 + n25, breakAt: null, pause: 0 })
    }
    const start = 23 * 60 + 30 - n25
    const end = 1440 + n40
    const span = end - start
    if (start >= 20 * 60 && span > 240 && span <= MAX_PAID_MIN && span <= paidCap) {
      push({ start, span, breakAt: n25, pause: 30 })
    }
  }

  if (n40 >= 240 && n25 >= 30 && n25 <= 240 && n40 + n25 <= 480) {
    const sum = n25 + 30
    for (let post = 0; post <= 120; post += 10) {
      const pre = sum - post
      if (pre < 30 || pre > 240) continue
      const start = 1440 - pre
      const end = 1680 + post
      const span = end - start
      if (start < 20 * 60 || span > MAX_PAID_MIN || span > paidCap || end > 1800) continue
      const latest = pre - 30
      for (let b = 0; b <= latest; b += 20) push({ start, span, breakAt: b, pause: 30 })
      if (post >= 30) {
        const breakAt = pre + 240
        if (breakAt + 30 <= span) push({ start, span, breakAt, pause: 30 })
      }
    }
  }

  return out
}

/**
 * Netto-Minuten je Sonntag. Volle 8 Std bleiben gleich lang (Gesetz),
 * kleinere Ziele werden auf unterschiedlich lange Sonntage verteilt.
 */
function sonntagNetto(total: number, anzahl: number, paidBudget: number, rng: Rng): number[] {
  const max = MAX_NET_MIN
  if (total < 60 || anzahl <= 0 || paidBudget < 60) return []
  const ziel = Math.min(total, anzahl * max)
  const minK = Math.ceil(ziel / max)
  if (minK > anzahl) return new Array(anzahl).fill(max)
  const maxK = Math.min(anzahl, Math.max(minK, Math.floor(ziel / Math.min(3 * 60, ziel))))
  let beste: number[] | null = null
  let besteNote = -1
  for (let k = minK; k <= maxK; k++) {
    const minTeil = Math.min(3 * 60, Math.floor(ziel / k))
    const teile = teileMinuten(ziel, k, max, minTeil, rng)
    if (!teile) continue
    const paid = teile.reduce((s, n) => s + spanFuerNetto(n), 0)
    if (paid > paidBudget) continue
    const verschieden = new Set(teile.map((n) => Math.round(n / 15))).size
    const erzwungenGleich = teile.every((n) => n === teile[0])
    const note = (erzwungenGleich ? 0 : 40) + verschieden * 10 + (k > minK && !erzwungenGleich ? 8 : 0) - paid / 60
    if (note > besteNote) { beste = teile; besteNote = note }
  }
  if (beste) return beste
  const not: number[] = []
  let rest = ziel
  for (let i = 0; i < anzahl && rest >= 60; i++) {
    const netto = Math.min(max, rest)
    const span = spanFuerNetto(netto)
    if (span > paidBudget) break
    not.push(netto)
    rest -= netto
  }
  return not
}

function teileMinuten(total: number, k: number, maxTeil: number, minTeil: number, rng: Rng): number[] | null {
  if (k <= 0 || total <= 0) return null
  if (k === 1) return total <= maxTeil ? [total] : null
  if (total < k * minTeil || total > k * maxTeil) return null
  const parts = new Array<number>(k).fill(minTeil)
  let left = total - k * minTeil
  let guard = 0
  while (left > 0 && guard++ < 20000) {
    let placed = false
    for (const step of [30, 15, 5, 1]) {
      if (left < step) continue
      let pick = -1
      let best = 1e9
      for (let i = 0; i < k; i++) {
        if (parts[i] + step > maxTeil) continue
        const next = parts[i] + step
        let same = 0
        for (let j = 0; j < k; j++) if (j !== i && Math.abs(parts[j] - next) < 25) same++
        const sc = same * 10 + rng()
        if (sc < best) { best = sc; pick = i }
      }
      if (pick < 0) continue
      parts[pick] += step
      left -= step
      placed = true
      break
    }
    if (!placed) return null
  }
  return parts
}

function sonntagStart(span: number, uhren: Uhren, rng: Rng): number {
  const earliest = 6 * 60
  const latest = Math.max(earliest, FILL_ENDE - span)
  let best = earliest
  let bestSc = -1e9
  for (let start = earliest; start <= latest; start += 5) {
    const end = start + span
    const ds = abstandZu(uhr(start), uhren.starts, true)
    const de = abstandZu(uhr(end), uhren.ends, true)
    let sc = Math.min(ds, 180) * 2 + Math.min(de, 180) * 2 + rng() * 6
    if (ds < 20) sc -= 2000
    if (de < 20) sc -= 2000
    if (sc > bestSc) { bestSc = sc; best = start }
  }
  return best
}

function pausenLage(span: number, index: number): number | null {
  const pause = pauseUndNetto(span).pause
  if (pause <= 0) return null
  const fracs = [0.22, 0.35, 0.48, 0.61, 0.74, 0.3, 0.55]
  const latest = span - pause
  const off = Math.round((latest * fracs[index % fracs.length]) / 5) * 5
  return Math.max(0, Math.min(off, latest))
}

function startImFenster(earliest: number, span: number, maxSpan: number, uhren: Uhren, rng: Rng): number {
  const latest = earliest + Math.max(0, maxSpan - span)
  let best = earliest
  let bestSc = -1e9
  const von = Math.ceil(earliest / 5) * 5
  if (von > latest) return earliest
  for (let start = von; start <= latest; start += 5) {
    const end = start + span
    if (end > earliest + maxSpan) continue
    const ds = abstandZu(uhr(start), uhren.starts, true)
    const de = abstandZu(uhr(end), uhren.ends, true)
    let sc = Math.min(ds, 180) * 2 + Math.min(de, 180) * 2 + rng() * 5
    if (ds < 20) sc -= 2000
    if (de < 20) sc -= 2000
    if (sc > bestSc) { bestSc = sc; best = start }
  }
  return best
}

function waehleFenster(pool: Fenster[], count: number, rng: Rng): Fenster[] {
  if (count <= 0) return []
  if (count >= pool.length) return [...pool]
  const scored = pool.map((f) => ({ f, sc: f.maxSpan + rng() * 150 }))
  scored.sort((a, b) => b.sc - a.sc)
  return scored.slice(0, count).map((s) => s.f)
}

function waehleDaten(dates: string[], count: number, rng: Rng): string[] {
  if (count <= 0) return []
  if (count >= dates.length) return [...dates].sort()
  const keys = dates.map(() => rng())
  return dates
    .map((d, i) => ({ d, k: keys[i] }))
    .sort((a, b) => a.k - b.k)
    .slice(0, count)
    .map((x) => x.d)
    .sort()
}

/**
 * Nächster Nachtbrocken. Jeder Brocken passt in eine Schicht, und der Rest
 * passt in die übrigen Schichten (höchstens 4 Std Nacht 40 % und 8 Std Netto).
 */
function waehleBiss(n40: number, n25: number, slots: number, rng: Rng): Biss | null {
  if (slots <= 0) return null
  if (n40 <= 1 && n25 <= 1) return null
  const min40 = n40 > 1 ? Math.max(0, n40 - (slots - 1) * 240) : 0
  const max40 = Math.min(240, Math.max(0, n40))
  if (min40 > max40) return null
  const versuche: number[] = []
  if (slots === 1 || (n40 <= 240 && n40 - min40 < 60)) versuche.push(max40)
  const span = Math.max(0, max40 - Math.max(min40, n40 > 0 ? Math.min(60, max40) : 0))
  const basis = Math.max(min40, Math.min(max40, n40 > 0 ? Math.max(min40, Math.min(60, max40)) : 0))
  for (let i = 0; i < 6; i++) {
    let x = slots === 1 ? max40 : Math.round(basis + rng() * Math.max(1, max40 - basis))
    if (n40 - x > 0 && n40 - x < 60 && n40 <= 240) x = n40
    x = clampN(x, min40, max40)
    versuche.push(x)
  }
  if (span === 0) versuche.push(max40)

  for (const x0 of versuche) {
    const x = clampN(Math.round(x0), min40, max40)
    const maxYCap = x <= 0 ? 240 : x >= 240 ? Math.min(240, 480 - x) : Math.min(210, 480 - x)
    const min25 = n25 > 1 ? Math.max(0, n25 - (slots - 1) * 240) : 0
    const max25 = Math.min(maxYCap, Math.max(0, n25))
    if (min25 > max25) continue
    let y = slots === 1 ? max25 : Math.round(min25 + rng() * Math.max(1, max25 - min25))
    if (n25 - y > 0 && n25 - y < 60 && n25 <= maxYCap) y = n25
    y = clampN(Math.round(y), min25, max25)
    if (x + y > 480) continue
    if (x < 15 && y < 15) continue
    if (x > 0 && x < 45 && x !== n40) continue
    if (y > 0 && y < 30 && y !== n25 && n25 >= 60) continue
    return { n40: x, n25: y }
  }
  const min25Pflicht = n25 > 1 ? Math.max(0, n25 - (slots - 1) * 240) : 0
  if (min25Pflicht > 0) return null
  return { n40: clampN(min40, 0, max40), n25: 0 }
}

/**
 * Plan nur aus den Monatsstunden. Der Nutzer gibt keine Uhrzeiten ein.
 * Reihenfolge: Sonntage, dann Nacht 40 % und Nacht 25 % (ohne die Quote zu überziehen),
 * dann der Rest auf Tage, an denen die 11-Std-Ruhe noch ein Fenster lässt.
 * Uhrzeiten und Tageslängen streuen. Dieselben Vorgaben bleiben stabil.
 * Höchstens 2 freie Tage je Woche, wenn dabei mindestens 3 Std/Tag möglich sind.
 */
export function erstellePlan(year: number, month1: number, ziel: VorschlagZiel): ManualResult {
  const warnings: string[] = []
  const kalender = monthDays(year, month1)
  const sonntage = kalender.filter((t) => t.dow === 0).map((t) => t.iso)
  let paidLeft = Math.round(Math.max(0, ziel.bezahlt) * 60)
  let sundayLeft = Math.round(Math.max(0, ziel.sunday) * 60)
  let n25Left = Math.round(Math.max(0, ziel.n25) * 60)
  let n40Left = Math.round(Math.max(0, ziel.n40) * 60)
  if (paidLeft <= 0) return berechneManuell([])

  const rng = rngAusZiel(year, month1, ziel)
  const uhren: Uhren = { starts: [], ends: [], dauern: [] }
  const schichten: RohSchicht[] = []
  const verwendet = new Set<string>()

  const sonntagTeile = sonntagNetto(sundayLeft, sonntage.length, paidLeft, rng)
  const sonntagTage = waehleDaten(sonntage, sonntagTeile.length, rng)
  for (let i = 0; i < sonntagTage.length; i++) {
    const date = sonntagTage[i]
    if (sundayLeft < 60 || paidLeft < 60) break
    let netto = Math.min(sonntagTeile[i] ?? 0, sundayLeft, MAX_NET_MIN)
    let span = spanFuerNetto(netto)
    if (span > paidLeft) {
      span = paidLeft
      netto = pauseUndNetto(span).nettoMin
    }
    if (netto < 60) break
    const s = baueSchicht(date, sonntagStart(span, uhren, rng), span, pausenLage(span, i))
    const h = stundenVon(s)
    schichten.push(s)
    verwendet.add(date)
    paidLeft -= s.endMin - s.startMin
    sundayLeft -= Math.round(h.sunday50 * 60)
    merkeSchicht(uhren, s)
  }

  const lege = (shape: Shape, date: string) => {
    const s = baueSchicht(date, shape.start, shape.span, shape.breakAt, shape.pause)
    const h = stundenVon(s)
    schichten.push(s)
    verwendet.add(date)
    paidLeft -= s.endMin - s.startMin
    n40Left -= Math.round(h.night40 * 60)
    n25Left -= Math.round(h.night25 * 60)
    merkeSchicht(uhren, s)
  }

  const findeDatum = (shape: Shape): string | null => {
    const dowZahl = new Map<number, number>()
    const wochenZahl = new Map<string, number>()
    for (const s of schichten) {
      const dow = dowOf(s.date)
      if (dow >= 1 && dow <= 5) dowZahl.set(dow, (dowZahl.get(dow) ?? 0) + 1)
      const key = mondayKey(s.date)
      wochenZahl.set(key, (wochenZahl.get(key) ?? 0) + 1)
    }
    let best: { date: string; sc: number } | null = null
    for (const t of kalender) {
      const iso = t.iso
      const dow = t.dow
      if (dow < 1 || dow > 5 || verwendet.has(iso)) continue
      if (!ruheOk(schichten, iso, shape.start, shape.start + shape.span)) continue
      let sc = -(dowZahl.get(dow) ?? 0) * 25 - (wochenZahl.get(mondayKey(iso)) ?? 0) * 12 + rng() * 18
      if (!best || sc > best.sc) best = { date: iso, sc }
    }
    return best ? best.date : null
  }

  const syncUhren = () => {
    uhren.starts.length = 0
    uhren.ends.length = 0
    uhren.dauern.length = 0
    for (const s of schichten) merkeSchicht(uhren, s)
  }

  const gleicheStunden = (a: number, b: number) => Math.abs(Math.round(a * 60) - Math.round(b * 60)) <= 1

  /** Restliche Zuschlagsminuten an eine bestehende Schicht hängen, statt einen kurzen Resttag zu erfinden. */
  const dehneArbeit = (add40: number, add25: number): boolean => {
    const need = add40 + add25
    if (need <= 0 || need > paidLeft || add40 > n40Left + 1 || add25 > n25Left + 1) return false
    for (const i of mische(schichten.map((_, k) => k), rng)) {
      const s = schichten[i]
      if (dowOf(s.date) === 0) continue
      const span0 = s.endMin - s.startMin
      const span = span0 + need
      if (span > MAX_PAID_MIN) continue
      const neu = baueSchicht(s.date, s.startMin, span, s.breaks[0]?.start ?? null, s.pause > 0 ? s.pause : null)
      if (!ruheOk(schichten.filter((_, k) => k !== i), neu.date, neu.startMin, neu.endMin)) continue
      const a = stundenVon(s)
      const b = stundenVon(neu)
      const d40 = Math.round(b.night40 * 60) - Math.round(a.night40 * 60)
      const d25 = Math.round(b.night25 * 60) - Math.round(a.night25 * 60)
      const dSo = Math.round(b.sunday50 * 60) - Math.round(a.sunday50 * 60)
      if (Math.abs(d40 - add40) > 1 || Math.abs(d25 - add25) > 1 || Math.abs(dSo) > 1) continue
      const delta = neu.endMin - neu.startMin - span0
      if (delta <= 0 || delta > paidLeft) continue
      const fremd = schichten.filter((_, k) => k !== i).map((x) => uhr(x.endMin))
      if (fremd.length > 0 && abstandZu(uhr(neu.endMin), fremd, true) < 12) continue
      schichten[i] = neu
      paidLeft -= delta
      n40Left -= d40
      n25Left -= d25
      syncUhren()
      return true
    }
    return false
  }

  /**
   * Bezahlte Restminuten, ohne Arbeitszeit oder Zuschlag zu ändern.
   * Zuerst echter Tag, danach eine Pause vor der bestehenden Arbeit.
   */
  const dehneTag = (T: number): boolean => {
    if (T <= 0 || T > paidLeft) return false
    let bestI = -1
    let bestNeu: RohSchicht | null = null
    let bestSc = -1e9
    for (let i = 0; i < schichten.length; i++) {
      const s = schichten[i]
      const a = stundenVon(s)
      if (a.night40 > 0.02 || a.night25 > 0.02 || s.startMin < 6 * 60) continue
      const span = s.endMin - s.startMin + T
      if (span > MAX_PAID_MIN || s.endMin + T > FILL_ENDE) continue
      const neu = baueSchicht(s.date, s.startMin, span, s.breaks[0]?.start ?? pausenLage(span, i))
      if (neu.endMin > FILL_ENDE) continue
      if (!ruheOk(schichten.filter((_, k) => k !== i), neu.date, neu.startMin, neu.endMin)) continue
      const b = stundenVon(neu)
      if (b.night40 > 0.02 || b.night25 > 0.02 || !gleicheStunden(a.sunday50, b.sunday50)) continue
      if (neu.endMin - neu.startMin - (s.endMin - s.startMin) !== T) continue
      let near = 9999
      for (let k = 0; k < schichten.length; k++) {
        if (k === i) continue
        near = Math.min(near, Math.abs((neu.endMin - neu.startMin) - (schichten[k].endMin - schichten[k].startMin)))
      }
      let sc = Math.min(near, 120) + rng()
      if (near < 20) sc -= 80
      if (sc > bestSc) { bestSc = sc; bestI = i; bestNeu = neu }
    }
    if (bestI < 0 || !bestNeu) return false
    schichten[bestI] = bestNeu
    paidLeft -= T
    return true
  }

  const dehnePausenfront = (T: number): boolean => {
    if (T <= 0 || T > paidLeft) return false
    let bestI = -1
    let bestNeu: RohSchicht | null = null
    let bestSc = -1e9
    for (let i = 0; i < schichten.length; i++) {
      const s = schichten[i]
      const altBreak = s.breaks[0]?.start ?? null
      if (s.pause > 0 && altBreak !== 0) continue
      const neuePause = s.pause + T
      if (neuePause > 120) continue
      const neuStart = s.startMin - T
      if (neuStart < 0) continue
      if (s.startMin >= 20 * 60) {
        if (neuStart < 20 * 60) continue
      } else if (s.startMin >= 6 * 60) {
        if (neuStart < 6 * 60) continue
      } else continue
      const span = s.endMin - s.startMin + T
      if (span > MAX_PAID_MIN || span <= neuePause) continue
      const neu = baueSchicht(s.date, neuStart, span, 0, neuePause)
      if (neu.pause !== neuePause) continue
      if (!ruheOk(schichten.filter((_, k) => k !== i), neu.date, neu.startMin, neu.endMin)) continue
      const a = stundenVon(s)
      const b = stundenVon(neu)
      if (!gleicheStunden(a.night40, b.night40) || !gleicheStunden(a.night25, b.night25) || !gleicheStunden(a.sunday50, b.sunday50)) continue
      if (neu.endMin - neu.startMin - (s.endMin - s.startMin) !== T) continue
      let nearD = 9999
      let nearS = 9999
      for (let k = 0; k < schichten.length; k++) {
        if (k === i) continue
        nearD = Math.min(nearD, Math.abs((neu.endMin - neu.startMin) - (schichten[k].endMin - schichten[k].startMin)))
        nearS = Math.min(nearS, abstandZu(uhr(neu.startMin), [uhr(schichten[k].startMin)], true))
      }
      let sc = Math.min(nearD, 90) + Math.min(nearS, 90) + rng()
      if (nearD < 15 || nearS < 10) sc -= 60
      if (sc > bestSc) { bestSc = sc; bestI = i; bestNeu = neu }
    }
    if (bestI < 0 || !bestNeu) return false
    schichten[bestI] = bestNeu
    paidLeft -= T
    return true
  }

  const schliessePaid = () => {
    let guard = 0
    while (paidLeft > 0 && guard++ < 80) {
      const ganz = paidLeft
      const grob = paidLeft > 90 ? 45 : paidLeft
      if (dehneTag(grob) || dehnePausenfront(grob)) continue
      if (grob !== ganz && (dehneTag(ganz) || dehnePausenfront(Math.min(ganz, 30)))) continue
      if (paidLeft >= 15 && (dehneTag(15) || dehnePausenfront(15))) continue
      if (paidLeft >= 5 && (dehneTag(5) || dehnePausenfront(5))) continue
      if (dehneTag(paidLeft) || dehnePausenfront(paidLeft)) continue
      break
    }
  }

  const fuelleBunt = (zielN: number): boolean => {
    let gelegt = 0
    let guard = 0
    while ((n40Left > 1 || n25Left > 1) && paidLeft >= 45 && gelegt < zielN && guard++ < 48) {
      if (gelegt > 0 && n40Left + n25Left < 90 && n40Left + n25Left <= paidLeft) {
        if (dehneArbeit(Math.max(0, n40Left), Math.max(0, n25Left))) continue
      }
      const slots = Math.max(1, zielN - gelegt)
      let placed = false
      for (let versuch = 0; versuch < 8 && !placed; versuch++) {
        const bite = waehleBiss(n40Left, n25Left, slots, rng)
        if (!bite || (bite.n40 < 15 && bite.n25 < 15)) continue
        const slack = paidLeft - n40Left - n25Left
        const eng = slack < 60 * slots
        const bewertet = formenFuer(bite.n40, bite.n25, paidLeft)
          .map((v) => ({ v, m: mess(v), sc: scoreForm(v, uhren) + rng() * 8 }))
          .filter(({ v, m }) => {
            if (m.paid > paidLeft || m.n40 > n40Left + 1 || m.n25 > n25Left + 1) return false
            if (n25Left <= 1 && m.n25 > 1) return false
            if (n40Left <= 1 && m.n40 > 1) return false
            if (paidLeft - m.paid < Math.max(0, n40Left - m.n40) + Math.max(0, n25Left - m.n25) - 1) return false
            if (eng && v.pause - pauseUndNetto(v.span).pause > 0) return false
            return true
          })
          .sort((a, b) => b.sc - a.sc)
        for (const { v } of bewertet) {
          const date = findeDatum(v)
          if (!date) continue
          lege(v, date)
          gelegt++
          placed = true
          break
        }
      }
      if (!placed) return false
    }
    return n40Left <= 1 && n25Left <= 1
  }

  const fuelleSicher = () => {
    const nachtPrio = [5, 1, 3, 4, 2]
    const naechstes = (start: number, span: number) => kalender
      .map((t) => t.iso)
      .filter((iso) => {
        const dow = dowOf(iso)
        return dow >= 1 && dow <= 5 && !verwendet.has(iso) && ruheOk(schichten, iso, start, start + span)
      })
      .sort((a, b) => nachtPrio.indexOf(dowOf(a)) - nachtPrio.indexOf(dowOf(b)) || a.localeCompare(b))[0]
    let guard = 0
    while ((n40Left > 30 || n25Left > 30) && paidLeft >= 60 && guard++ < 40) {
      const entwurf = nachtEntwurf(n40Left, n25Left, paidLeft)
      if (!entwurf) break
      const vorlage = baueSchicht(MESS_TAG, entwurf.start, entwurf.span, entwurf.breakAt, entwurf.pause)
      const hv = stundenVon(vorlage)
      const want40 = Math.round(hv.night40 * 60)
      const want25 = Math.round(hv.night25 * 60)
      const bewerte = (v: Shape) => {
        const m = mess(v)
        let sc = scoreForm(v, uhren) + rng()
        if (n40Left > paidLeft + 30 && m.paid > 0) sc += (m.n40 / m.paid) * 600
        return { v, m, sc }
      }
      const treffer = formenFuer(want40, want25, paidLeft)
        .map((v) => bewerte(v))
        .filter(({ m }) => Math.abs(m.n40 - want40) <= 1 && Math.abs(m.n25 - want25) <= 1 && m.paid <= paidLeft)
      const minPaid = treffer.reduce((m, x) => Math.min(m, x.m.paid), 1e9)
      let passend = treffer.filter((x) => x.m.paid <= minPaid + 1).sort((a, b) => b.sc - a.sc)
      if (n40Left > paidLeft + 30 && passend.length > 0) {
        const top = passend[0].v
        const kollision = abstandZu(uhr(top.start), uhren.starts, true) < 20
          || abstandZu(uhr(top.start + top.span), uhren.ends, true) < 20
        if (kollision) {
          for (const abzug of [30, 60, 90, 120]) {
            const ziel40 = want40 - abzug
            if (ziel40 < 60) continue
            passend.push(...formenFuer(ziel40, want25, paidLeft)
              .map((v) => bewerte(v))
              .filter(({ m }) => Math.abs(m.n40 - ziel40) <= 1 && Math.abs(m.n25 - want25) <= 1 && m.paid <= paidLeft))
          }
          passend.sort((a, b) => b.sc - a.sc)
        }
      }
      const frei = passend.filter(({ v }) => abstandZu(uhr(v.start), uhren.starts, true) >= 20 && abstandZu(uhr(v.start + v.span), uhren.ends, true) >= 20)
      const reihe = frei.length > 0 ? frei : passend
      let gesetzt = false
      for (const { v } of reihe) {
        const date = naechstes(v.start, v.span)
        if (!date) continue
        lege(v, date)
        gesetzt = true
        break
      }
      if (gesetzt) continue
      const date = naechstes(entwurf.start, entwurf.span)
      if (!date) break
      const s = baueSchicht(date, entwurf.start, entwurf.span, entwurf.breakAt, entwurf.pause)
      const h = stundenVon(s)
      const got40 = Math.round(h.night40 * 60)
      const got25 = Math.round(h.night25 * 60)
      if (got40 < 15 && got25 < 15) break
      schichten.push(s)
      verwendet.add(date)
      paidLeft -= s.endMin - s.startMin
      n40Left -= got40
      n25Left -= got25
      merkeSchicht(uhren, s)
    }
  }

  const schnapp = () => ({
    schichten: schichten.map((s) => ({ ...s, breaks: s.breaks.map((b) => ({ ...b })) })),
    verwendet: [...verwendet],
    paidLeft,
    n40Left,
    n25Left,
    starts: [...uhren.starts],
    ends: [...uhren.ends],
    dauern: [...uhren.dauern],
  })
  const zurueck = (st: ReturnType<typeof schnapp>) => {
    schichten.splice(0, schichten.length, ...st.schichten.map((s) => ({ ...s, breaks: s.breaks.map((b) => ({ ...b })) })))
    verwendet.clear()
    for (const d of st.verwendet) verwendet.add(d)
    paidLeft = st.paidLeft
    n40Left = st.n40Left
    n25Left = st.n25Left
    uhren.starts.splice(0, uhren.starts.length, ...st.starts)
    uhren.ends.splice(0, uhren.ends.length, ...st.ends)
    uhren.dauern.splice(0, uhren.dauern.length, ...st.dauern)
  }

  const weekdays = kalender.filter((t) => t.dow >= 1 && t.dow <= 5 && !verwendet.has(t.iso)).length
  const minN = Math.max(
    n40Left > 1 ? Math.ceil(n40Left / 240) : 0,
    n25Left > 1 ? Math.ceil(n25Left / 240) : 0,
    n40Left + n25Left > 1 ? Math.ceil((n40Left + n25Left) / MAX_NET_MIN) : 0,
  )
  if (minN > 0 && weekdays > 0) {
    const basis = schnapp()
    const slack = paidLeft - n40Left - n25Left
    const extraCap = slack >= 6 * 60 ? 4 : slack >= 2 * 60 ? 2 : 0
    let fertig = false
    for (const extra of [...new Set([extraCap, extraCap > 0 ? Math.ceil(extraCap / 2) : 0, 0])]) {
      zurueck(basis)
      const ziel = Math.min(weekdays, minN + extra)
      if (ziel > 0 && fuelleBunt(ziel)) { fertig = true; break }
    }
    if (!fertig) {
      zurueck(basis)
      fuelleSicher()
    }
  }

  const wochen = new Map<string, string[]>()
  for (const t of kalender) {
    const key = mondayKey(t.iso)
    wochen.set(key, [...(wochen.get(key) ?? []), t.iso])
  }

  const fensterAm = (date: string): Fenster | null => {
    if (verwendet.has(date) || dowOf(date) === 0) return null
    let start = 6 * 60
    let end = FILL_ENDE
    const day = absMin(date, 0)
    let prevEnd: number | null = null
    let nextStart: number | null = null
    for (const s of schichten) {
      const ps = absMin(s.date, s.startMin)
      const pe = absMin(s.date, s.endMin)
      if (pe <= day + FILL_ENDE && (prevEnd == null || pe > prevEnd)) prevEnd = pe
      if (ps >= day + start && (nextStart == null || ps < nextStart)) nextStart = ps
    }
    if (prevEnd != null) start = Math.max(start, prevEnd + REST_MIN - day)
    if (nextStart != null) end = Math.min(end, nextStart - REST_MIN - day)
    if (start >= 24 * 60 || end - start < 60) return null
    return { date, startMin: start, maxSpan: end - start }
  }

  const alleFenster = kalender.map((t) => fensterAm(t.iso)).filter((f): f is Fenster => f != null)
  const fensterNachDatum = new Map(alleFenster.map((f) => [f.date, f]))
  const kapazitaet = (liste: Fenster[]) => liste.reduce((summe, f) => summe + Math.min(f.maxSpan, MAX_PAID_MIN), 0)

  let gewaehlt: Fenster[] = []
  let muss = 0
  if (paidLeft >= 60 && alleFenster.length > 0) {
    for (const dates of wochen.values()) {
      const pool = dates.map((iso) => fensterNachDatum.get(iso)).filter((f): f is Fenster => f != null)
      const frei = dates.filter((iso) => !verwendet.has(iso)).length
      const noch = Math.max(0, frei - 2)
      for (const f of waehleFenster(pool, Math.min(noch, pool.length), rng)) gewaehlt.push(f)
    }
    muss = gewaehlt.length
    if (muss > 0 && paidLeft < muss * MIN_PAID_MIN) {
      const maxCount = Math.max(1, Math.min(gewaehlt.length, Math.floor(paidLeft / MIN_PAID_MIN)))
      const minCount = Math.max(1, Math.ceil(paidLeft / MAX_PAID_MIN))
      let count = maxCount
      while (count > minCount && paidLeft - count * MIN_PAID_MIN < count * 45) count--
      const daten = waehleDaten(gewaehlt.map((f) => f.date), Math.min(count, gewaehlt.length), rng)
      gewaehlt = daten.map((date) => fensterNachDatum.get(date)).filter((f): f is Fenster => f != null)
      warnings.push('Zu wenig Stunden für höchstens 2 freie Tage je Woche bei mind. 3 Std/Tag. Die übrigen Stunden liegen auf weniger Tagen, unterschiedlich lang.')
    } else {
      const rest = alleFenster.filter((f) => !gewaehlt.some((g) => g.date === f.date))
        .sort((a, b) => b.maxSpan - a.maxSpan || a.date.localeCompare(b.date))
      let extra = 0
      while (kapazitaet(gewaehlt) < paidLeft && extra < rest.length) {
        gewaehlt.push(rest[extra])
        extra++
      }
    }
  }

  if (gewaehlt.length > 0 && paidLeft >= 60) {
    gewaehlt.sort((a, b) => a.date.localeCompare(b.date))
    const spans = verteilUngleich(gewaehlt.map((f) => Math.min(f.maxSpan, MAX_PAID_MIN)), paidLeft, rng)
    gewaehlt.forEach((f, i) => {
      const span = spans[i] ?? 0
      if (span < 60) return
      const lage = pausenLage(span, i)
      let s = baueSchicht(f.date, startImFenster(f.startMin, span, f.maxSpan, uhren, rng), span, lage)
      if (!ruheOk(schichten, f.date, s.startMin, s.endMin)) s = baueSchicht(f.date, f.startMin, span, lage)
      if (!ruheOk(schichten, f.date, s.startMin, s.endMin)) return
      schichten.push(s)
      verwendet.add(f.date)
      paidLeft -= s.endMin - s.startMin
      merkeSchicht(uhren, s)
    })
  }

  schliessePaid()

  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (let i = 0; i < schichten.length; i++) {
      const s = schichten[i]
      const span = s.endMin - s.startMin
      const fremdS = schichten.filter((_, k) => k !== i).map((x) => uhr(x.startMin))
      const fremdE = schichten.filter((_, k) => k !== i).map((x) => uhr(x.endMin))
      const ds0 = abstandZu(uhr(s.startMin), fremdS, true)
      const de0 = abstandZu(uhr(s.endMin), fremdE, true)
      if (ds0 >= 20 && de0 >= 20) continue
      const h0 = stundenVon(s)
      const sonntag = dowOf(s.date) === 0
      const fenster = fensterNachDatum.get(s.date)
      const tag = !sonntag && h0.night40 < 0.02 && h0.night25 < 0.02 && s.startMin >= 6 * 60
      let lo = s.startMin - 90
      let hi = s.startMin + 90
      if (sonntag || tag) {
        const earliest = fenster ? fenster.startMin : 6 * 60
        const room = fenster ? fenster.maxSpan : FILL_ENDE - earliest
        lo = Math.max(lo, earliest)
        hi = Math.min(hi, earliest + Math.max(0, room - span))
      } else if (s.startMin >= 20 * 60) {
        lo = Math.max(lo, 20 * 60)
      } else if (s.startMin < 6 * 60) {
        lo = Math.max(lo, 15)
        hi = Math.min(hi, Math.max(lo, 4 * 60 - span))
      }
      let best = s.startMin
      let bestSc = -1
      for (let start = Math.ceil(lo / 5) * 5; start <= hi; start += 5) {
        if (start === s.startMin || uhr(start) === 0) continue
        const end = start + span
        if (!ruheOk(schichten.filter((_, k) => k !== i), s.date, start, end)) continue
        const probe = baueSchicht(s.date, start, span, s.breaks[0]?.start ?? null, s.pause > 0 ? s.pause : null)
        if (probe.endMin - probe.startMin !== span) continue
        const h = stundenVon(probe)
        if (!gleicheStunden(h.night40, h0.night40) || !gleicheStunden(h.night25, h0.night25) || !gleicheStunden(h.sunday50, h0.sunday50)) continue
        const ds = abstandZu(uhr(start), fremdS, true)
        const de = abstandZu(uhr(end), fremdE, true)
        if (ds < 20 || de < 20) continue
        const sc = Math.min(ds, 180) + Math.min(de, 180)
        if (sc > bestSc) { bestSc = sc; best = start }
      }
      if (best === s.startMin) continue
      schichten[i] = baueSchicht(s.date, best, span, s.breaks[0]?.start ?? null, s.pause > 0 ? s.pause : null)
      moved = true
    }
    if (!moved) break
  }

  if (sundayLeft > 30) warnings.push(`Sonntag: ${round2(sundayLeft / 60)} Std passen nicht in den Monat oder ins Stundenbudget.`)
  if (n40Left > 30) warnings.push(`Nacht 40 %: ${round2(n40Left / 60)} Std passen nicht ins Stundenbudget.`)
  if (n25Left > 30) warnings.push(`Nacht 25 %: ${round2(n25Left / 60)} Std passen nicht ins Stundenbudget.`)
  if (paidLeft > 30) warnings.push(`${round2(paidLeft / 60)} Std bleiben übrig. Mehr passt nicht in den Monat, ohne die 11-Std-Ruhe oder 8 Std am Tag zu reißen.`)

  const freiZuViel = [...wochen.values()].filter((dates) => dates.filter((iso) => !verwendet.has(iso)).length > 2).length
  const budgetKnapp = warnings.some((w) => w.startsWith('Zu wenig Stunden'))
  if (freiZuViel > 0 && !budgetKnapp && paidLeft <= 30 && (ziel.sunday > 0 || ziel.n25 > 0 || ziel.n40 > 0)) {
    warnings.push('Mehr als 2 freie Tage in manchen Wochen: Sonntag und Nacht verbrauchen die Stunden in langen Schichten.')
  } else if (freiZuViel > 0 && !budgetKnapp && paidLeft > 30) {
    warnings.push('Mehr als 2 freie Tage in manchen Wochen: die 11-Std-Ruhe nach einer Nachtschicht lässt dort keine weitere Schicht zu.')
  }

  const ergebnis = ausRoh(schichten, warnings)
  const n25Mehr = ergebnis.summe.n25 - Math.max(0, ziel.n25)
  if (n25Mehr > 0.3) {
    ergebnis.warnings.push(`Nacht 25 %: ${round2(n25Mehr)} Std entstehen mit, weil die Nachtschicht vor Mitternacht beginnt.`)
  }
  return ergebnis
}

function ausRoh(roh: RohSchicht[], extra: string[]): ManualResult {
  const sorted = [...roh].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)
  const tage: DayResult[] = []
  const warnings = [...extra]
  let prevEndMs: number | null = null
  let ruheVerletzungen = 0
  for (const s of sorted) {
    const startMs = dayStartMs(s.date) + s.startMin * 60000
    const endMs = dayStartMs(s.date) + s.endMin * 60000
    const ruhe = prevEndMs != null ? round2((startMs - prevEndMs) / 3600000) : null
    if (ruhe != null && ruhe < 11) ruheVerletzungen++
    const h = stundenVon(s)
    const hinweise: string[] = []
    if (ruhe != null && ruhe < 11) hinweise.push('Ruhezeit unter 11 Std.')
    prevEndMs = endMs
    tage.push({
      date: s.date, aktiv: true,
      von: minToClock(s.startMin), bis: minToClock(s.endMin),
      startMin: s.startMin, endMin: s.endMin,
      start: minToClock(s.startMin), ende: minToClock(s.endMin), overnight: s.endMin >= 1440,
      pause: s.pause, breaks: s.breaks,
      bezahlt: round2((s.endMin - s.startMin) / 60), netto: round2(h.workedHours),
      ruhe, n25: round2(h.night25), n40: round2(h.night40), so: round2(h.sunday50),
      warnung: hinweise.length ? hinweise.join(' ') : null,
    })
  }
  const ruhen = tage.map((t) => t.ruhe).filter((v): v is number => v != null)
  const minRuhe = ruhen.length ? Math.min(...ruhen) : null
  if (ruheVerletzungen > 0) warnings.unshift(`Ruhezeit unter 11 Std an ${ruheVerletzungen} Tag(en).`)
  // Summe aus den Rohminuten, nicht aus den schon gerundeten Tageswerten.
  let paidMin = 0
  let nettoH = 0
  let n25H = 0
  let n40H = 0
  let soH = 0
  for (const s of sorted) {
    paidMin += s.endMin - s.startMin
    const h = stundenVon(s)
    nettoH += h.workedHours
    n25H += h.night25
    n40H += h.night40
    soH += h.sunday50
  }
  return {
    tage, warnings,
    summe: {
      netto: round2(nettoH), bezahlt: round2(paidMin / 60),
      n25: round2(n25H), n40: round2(n40H), so: round2(soH),
      minRuhe, ruheVerletzt: minRuhe != null && minRuhe < 11,
    },
  }
}
