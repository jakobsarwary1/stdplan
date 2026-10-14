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
//   • Nachtschicht beginnt abends (20:00 oder 23:00), nie um 00:00.
//     Der Folgetag bleibt frei, damit die 11 Std Ruhe nicht in den Morgen laufen.
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

/** Schicht mit festem Start. Die Pause liegt bei `breakAt` Minuten nach Beginn, sonst um die Mitte, auf eine Viertelstunde gezogen. */
function baueSchicht(date: string, startMin: number, spanMin: number, breakAt: number | null): RohSchicht {
  const span = Math.max(0, Math.round(spanMin))
  const { pause } = pauseUndNetto(span)
  let off = breakAt
  if (pause <= 0) off = null
  else if (off == null) {
    const mid = Math.round((span - pause) / 2)
    const snap = Math.round(mid / 15) * 15
    off = Math.max(0, Math.min(snap, span - pause))
  } else off = Math.max(0, Math.min(Math.round(off), span - pause))
  const breaks = pause > 0 && off != null ? [{ start: off, end: off + pause }] : []
  return { date, startMin, endMin: startMin + span, pause: breaks.length ? pause : 0, breaks }
}

function stundenVon(s: RohSchicht) {
  return computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.breaks })
}

/**
 * Verteilt Minuten auf k Schichten, jede höchstens `max`.
 * Zuerst Viertelstunden, damit Beginn und Ende auf :00/:15/:30/:45 fallen,
 * dann 6 Minuten, dann der Rest Minute für Minute. Die Summe bleibt exakt.
 */
function verteilSpannen(total: number, k: number, max: number): { spans: number[]; uebrig: number } {
  if (k <= 0 || total <= 0) return { spans: [], uebrig: Math.max(0, total) }
  const spans = Array.from({ length: k }, () => 0)
  let left = Math.round(total)
  const base15 = Math.min(max, Math.floor(Math.floor(left / k) / 15) * 15)
  if (base15 > 0) {
    for (let i = 0; i < k; i++) spans[i] = base15
    left -= base15 * k
  }
  const give = (step: number) => {
    let guard = 0
    while (left >= step && guard++ < k * 80) {
      let placed = false
      for (let i = 0; i < k && left >= step; i++) {
        if (max - spans[i] >= step) {
          spans[i] += step
          left -= step
          placed = true
        }
      }
      if (!placed) break
    }
  }
  give(15)
  give(6)
  give(1)
  return { spans, uebrig: left }
}

/**
 * Plan nur aus den Monatsstunden. Der Nutzer gibt keine Uhrzeiten ein.
 * Reihenfolge: Sonntage, dann Nacht 40 % (abends ab 20:00, damit 00–04 Uhr
 * getroffen wird), dann Nacht 25 %, dann der Rest.
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

  const schichten: RohSchicht[] = []
  const verwendet = new Set<string>()
  const gesperrt = new Set<string>()

  for (const date of sonntage) {
    if (sundayLeft < 60 || paidLeft < 60) break
    let netto = Math.min(MAX_NET_MIN, sundayLeft)
    let span = spanFuerNetto(netto)
    if (span > paidLeft) {
      span = paidLeft
      netto = pauseUndNetto(span).nettoMin
    }
    if (netto < 60) break
    const s = baueSchicht(date, 6 * 60, span, null)
    const h = stundenVon(s)
    schichten.push(s)
    verwendet.add(date)
    paidLeft -= Math.round((s.endMin - s.startMin))
    sundayLeft -= Math.round(h.sunday50 * 60)
  }

  const nachtPrio = [5, 1, 3, 4, 2]
  const naechsteNacht = () => kalender
    .map((t) => t.iso)
    .filter((iso) => {
      const dow = dowOf(iso)
      return dow >= 1 && dow <= 5 && !verwendet.has(iso) && !gesperrt.has(iso) && !verwendet.has(shiftIso(iso, 1))
    })
    .sort((a, b) => nachtPrio.indexOf(dowOf(a)) - nachtPrio.indexOf(dowOf(b)) || a.localeCompare(b))[0]

  let guard = 0
  while ((n40Left > 30 || n25Left > 30) && paidLeft >= 60 && guard++ < 40) {
    const date = naechsteNacht()
    if (!date) break
    const vorher = n40Left + n25Left
    let start = 20 * 60
    let span = 0
    let breakAt: number | null = null
    if (n40Left > 30) {
      if (n25Left < 60) {
        start = 23 * 60
        span = Math.min(5 * 60, paidLeft)
        breakAt = 30
      } else {
        span = Math.min(510, paidLeft)
        breakAt = span > 240 ? 210 : null
      }
    } else {
      span = Math.min(4 * 60, n25Left, paidLeft)
      breakAt = null
    }
    if (span < 60) break
    const s = baueSchicht(date, start, span, breakAt)
    const h = stundenVon(s)
    schichten.push(s)
    verwendet.add(date)
    gesperrt.add(shiftIso(date, 1))
    paidLeft -= s.endMin - s.startMin
    n40Left -= Math.round(h.night40 * 60)
    n25Left -= Math.round(h.night25 * 60)
    if (n40Left + n25Left > vorher - 15) break
  }

  const wochen = new Map<string, string[]>()
  for (const t of kalender) {
    const key = mondayKey(t.iso)
    wochen.set(key, [...(wochen.get(key) ?? []), t.iso])
  }
  const poolJeWoche: string[][] = []
  let minExtra = 0
  for (const dates of wochen.values()) {
    const frei = dates.filter((iso) => !verwendet.has(iso))
    const noch = Math.max(0, frei.length - 2)
    const pool = frei.filter((iso) => !gesperrt.has(iso) && dowOf(iso) !== 0).sort()
    const n = Math.min(noch, pool.length)
    minExtra += n
    poolJeWoche.push(pool)
  }
  const allePool = poolJeWoche.flat()
  const dreiStunden = paidLeft >= minExtra * MIN_PAID_MIN
  let filler: string[] = []
  if (paidLeft >= 60 && allePool.length > 0) {
    if (!dreiStunden) {
      const count = paidLeft < MIN_PAID_MIN ? 1 : Math.min(allePool.length, Math.floor(paidLeft / MIN_PAID_MIN))
      filler = pickEven(allePool, Math.max(1, count))
      if (minExtra > 0) warnings.push('Zu wenig Stunden für höchstens 2 freie Tage je Woche bei mind. 3 Std/Tag. Die übrigen Stunden liegen gleichmäßig auf weniger Tagen.')
    } else {
      for (const pool of poolJeWoche) {
        const dates = [...wochen.values()][poolJeWoche.indexOf(pool)]
        const frei = dates.filter((iso) => !verwendet.has(iso))
        const noch = Math.max(0, frei.length - 2)
        filler.push(...pickEven(pool, Math.min(noch, pool.length)))
      }
      const rest = allePool.filter((iso) => !filler.includes(iso))
      let extraGuard = 0
      while (filler.length > 0 && filler.length < allePool.length && paidLeft / filler.length > MAX_PAID_MIN && rest.length > 0 && extraGuard++ < 31) {
        if (paidLeft / (filler.length + 1) < MIN_PAID_MIN) break
        filler.push(rest.shift()!)
      }
      if (filler.length === 0) {
        const count = Math.min(allePool.length, Math.max(1, Math.floor(paidLeft / MIN_PAID_MIN)))
        filler = pickEven(allePool, count)
      }
    }
  }

  if (filler.length > 0) {
    const { spans } = verteilSpannen(paidLeft, filler.length, MAX_PAID_MIN)
    for (let i = 0; i < filler.length; i++) {
      if (spans[i] < 60) continue
      const s = baueSchicht(filler[i], 6 * 60, spans[i], null)
      schichten.push(s)
      verwendet.add(filler[i])
      paidLeft -= s.endMin - s.startMin
    }
  }

  if (sundayLeft > 30) warnings.push(`Sonntag: ${round2(sundayLeft / 60)} Std passen nicht in den Monat oder ins Stundenbudget.`)
  if (n40Left > 30) warnings.push(`Nacht 40 %: ${round2(n40Left / 60)} Std passen nicht ins Stundenbudget.`)
  if (n25Left > 30) warnings.push(`Nacht 25 %: ${round2(n25Left / 60)} Std passen nicht ins Stundenbudget.`)
  if (paidLeft > 30) warnings.push(`${round2(paidLeft / 60)} Std bleiben übrig (max. 8 Netto-Std je Tag).`)

  const freiZuViel = [...wochen.values()].filter((dates) => dates.filter((iso) => !verwendet.has(iso)).length > 2).length
  const budgetKnapp = warnings.some((w) => w.startsWith('Zu wenig Stunden'))
  if (freiZuViel > 0 && !budgetKnapp) {
    if (ziel.sunday > 0 || ziel.n25 > 0 || ziel.n40 > 0) {
      warnings.push('Mehr als 2 freie Tage in manchen Wochen: Sonntag und Nacht verbrauchen die Stunden in langen Schichten.')
    } else {
      warnings.push('Nicht überall höchstens 2 freie Tage: das Stundenbudget lässt das bei mindestens 3 Std/Tag nicht zu.')
    }
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
