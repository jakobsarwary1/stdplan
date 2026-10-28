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
import { computeShiftHours } from './wage'
import { erstellePlan, type ManualResult } from './manual'

const MAX_NET_MIN = 8 * 60
const MAX_PAUSE_MIN = 90 // 1,5 h – betriebliche Obergrenze (wie im Uber-Pfad)
const H = 3600000

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const sub = (a: { so: number; n25: number; n40: number; fe: number }, b: { so: number; n25: number; n40: number; fe: number }) =>
  ({ so: a.so - b.so, n25: a.n25 - b.n25, n40: a.n40 - b.n40, fe: a.fe - b.fe })

export type ZielVorgabe = {
  /** Bezahlte Arbeitszeit des Monats OHNE Pause (Stunden). */
  gesamt: number
  /** Davon an Sonntagen (Stunden). */
  sonntag: number
  /** Davon Nacht 25 % (04–06 & 20–24 Uhr), optional. */
  nacht25?: number
  /** Davon Nacht 40 % steuerfrei (00–04 Uhr), optional. */
  nacht40?: number
  /** Davon Feiertag (Stunden), optional. Braucht Feiertagsdaten. */
  feiertag?: number
  /** Feiertage des Monats als "YYYY-MM-DD" (für die Feiertags-Zuordnung). */
  feiertage?: string[]
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

/** Alle Sonntage eines Monats "YYYY-MM" als ISO-Datum. */
function sonntageImMonat(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  if (!m) return []
  const out: string[] = []
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  while (d.getUTCMonth() === Number(m[2]) - 1) {
    if (d.getUTCDay() === 0) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/**
 * Bringt einen Fahrer-Plan auf die Monats-Zielstunden. Echte Arbeitstage und
 * Startzeiten bleiben, die Längen werden skaliert; die Monatssumme trifft das
 * Gesamt EXAKT. Sonntag zählt als TATSÄCHLICHE Stunden ab 00:00 (die Nacht von
 * Samstag auf Sonntag fließt also mit ein). Reichen die echten Sonntage nicht,
 * dürfen – nur für den Sonntag – zusätzliche Sonntage angesetzt werden.
 */
export function planAnZiel(plan: DriverPlan, ziel: ZielVorgabe): DriverPlan {
  const gesamtMin = Math.round(Math.max(0, ziel.gesamt) * 60)
  let sonntagMin = Math.round(Math.max(0, ziel.sonntag) * 60)
  const warnungen: string[] = []
  if (sonntagMin > gesamtMin) {
    warnungen.push(`Sonntag (${ziel.sonntag} h) ist größer als Gesamt (${ziel.gesamt} h) – Sonntag auf Gesamt begrenzt.`)
    sonntagMin = gesamtMin
  }

  // Echte Arbeitstage: Startzeit, Pause und gefahrene Länge je Tag.
  type Tagq = { date: string; startMs: number; realNet: number; realPause: number }
  const echte: Tagq[] = []
  for (const tag of plan.days) {
    if (tag.kind !== 'schicht' || tag.shifts.length === 0) continue
    echte.push({
      date: tag.date,
      startMs: Math.min(...tag.shifts.map((s) => s.startMs)),
      realNet: tag.shifts.reduce((a, s) => a + s.nettoH, 0) * 60,
      realPause: Math.max(0, ...tag.shifts.map((s) => s.pauseH)) * 60,
    })
  }

  // Start-/Pausen-Nachschlag je Datum (echte Tage + evtl. zusätzliche Sonntage).
  const startOf = new Map<string, number>()
  const pauseOf = new Map<string, number>()
  echte.forEach((t) => { startOf.set(t.date, t.startMs); pauseOf.set(t.date, t.realPause) })

  // Tatsächliche Sonntagsminuten eines Datums bei Netto n (via Zuschlagsrechnung,
  // mitternachtsgenau und pausenbereinigt). Memoisiert, weil der Sonntags-
  // Abgleich sie oft mit denselben Werten abfragt. Liefert je Datum+Netto die
  // Zuschlagsminuten (Sonntag / Nacht 25 / Nacht 40 / Feiertag), mitternachts-
  // und pausengenau über dieselbe § 3b-Rechnung wie Vorschau und Excel.
  type Zus = { so: number; n25: number; n40: number; fe: number }
  const feSet = new Set(ziel.feiertage ?? [])
  const bMemo = new Map<string, Zus>()
  const beitrag = (date: string, n: number): Zus => {
    if (n <= 0) return { so: 0, n25: 0, n40: 0, fe: 0 }
    const key = `${date}|${n}`
    const c = bMemo.get(key)
    if (c) return c
    const startMs = startOf.get(date) ?? Date.parse(`${date}T10:00:00Z`)
    const sh = baueSchicht(startMs, n, pauseOf.get(date) ?? 30, null)
    const h = computeShiftHours({ date: sh.date, startMin: sh.startMin, endMin: sh.endMin, breaks: sh.pauseAt }, feSet)
    const v: Zus = { so: Math.round(h.sunday50 * 60), n25: Math.round(h.night25 * 60), n40: Math.round(h.night40 * 60), fe: Math.round(h.holiday125 * 60) }
    bMemo.set(key, v)
    return v
  }

  const istSo = (d: string) => weekdayIndex(d) === 0
  const alleSonntage = sonntageImMonat(plan.month)
  const echteSoSet = new Set(echte.filter((t) => istSo(t.date)).map((t) => t.date))

  // ---- GRUNDVERTEILUNG: Gesamt proportional zur gefahrenen Länge auf ALLE
  // echten Tage (auch Sonntage). So wird bei z. B. zwei gefahrenen Tagen auf
  // beide dünn gestreckt (5 + 5 h), nicht alles mit 8 h auf einen Tag. ----
  const netById = new Map<string, number>()
  const grund = skaliere(echte.map((t) => t.realNet), gesamtMin)
  echte.forEach((t, i) => netById.set(t.date, grund.vals[i]))
  if (grund.fehlt > 1) warnungen.push(`${round2(grund.fehlt / 60)} h passen nicht auf die ${echte.length} echten Tage (max. 8 h/Tag) – Gesamt wird nicht ganz erreicht.`)

  // ---- ZUSCHLÄGE (Sonntag / Nacht 25 % / Nacht 40 % / Feiertag) exakt treffen.
  // Lokale Suche: Netto wird minutenweise zwischen Tagen VERSCHOBEN (Gesamt
  // bleibt konstant), bis die Summe der tatsächlichen Zuschlagsstunden den
  // Zielen am nächsten ist. Mehrere Zuschläge werden gleichzeitig abgewogen
  // (eine Samstagnacht-Stunde zählt z. B. bei Nacht 40 % UND Sonntag). Nur
  // Zuschläge mit Vorgabe > 0 werden geregelt; für den Sonntag dürfen zusätzlich
  // Kalender-Sonntage angesetzt werden, wenn die echten nicht reichen. ----
  const zielK: Zus = {
    so: sonntagMin,
    n25: Math.round(Math.max(0, ziel.nacht25 ?? 0) * 60),
    n40: Math.round(Math.max(0, ziel.nacht40 ?? 0) * 60),
    fe: Math.round(Math.max(0, ziel.feiertag ?? 0) * 60),
  }
  const aktiv = (['so', 'n25', 'n40', 'fe'] as const).filter((k) => zielK[k] > 0)
  if (aktiv.length > 0) {
    if (zielK.so > 0) {
      for (const d of alleSonntage) {
        if (!startOf.has(d)) { startOf.set(d, Date.parse(`${d}T10:00:00Z`)); pauseOf.set(d, 30) }
        if (!netById.has(d)) netById.set(d, 0)
      }
    }
    const summe = (): Zus => {
      const a: Zus = { so: 0, n25: 0, n40: 0, fe: 0 }
      for (const d of netById.keys()) { const b = beitrag(d, netById.get(d) || 0); a.so += b.so; a.n25 += b.n25; a.n40 += b.n40; a.fe += b.fe }
      return a
    }
    const fehler = (c: Zus) => aktiv.reduce((s, k) => s + Math.abs(c[k] - zielK[k]), 0)
    for (const step of [15, 5, 1]) {
      let guard = 0
      while (guard++ < 4000) {
        const c0 = summe()
        const e0 = fehler(c0)
        if (e0 <= 1) break
        const dates = [...netById.keys()]
        const gain = new Map<string, Zus | null>()
        const loss = new Map<string, Zus | null>()
        for (const d of dates) {
          const nd = netById.get(d) || 0
          const b0 = beitrag(d, nd)
          gain.set(d, nd + step <= MAX_NET_MIN ? sub(beitrag(d, nd + step), b0) : null)
          loss.set(d, nd >= step ? sub(b0, beitrag(d, nd - step)) : null)
        }
        let best: [string, string] | null = null
        let bestErr = e0
        for (const i of dates) {
          const gi = gain.get(i); if (!gi) continue
          for (const j of dates) {
            if (j === i) continue
            const lj = loss.get(j); if (!lj) continue
            let e = 0
            for (const k of aktiv) e += Math.abs(c0[k] + gi[k] - lj[k] - zielK[k])
            if (e < bestErr - 0.001) { bestErr = e; best = [i, j] }
          }
        }
        if (!best) break
        netById.set(best[0], (netById.get(best[0]) || 0) + step)
        netById.set(best[1], (netById.get(best[1]) || 0) - step)
      }
    }
    const c = summe()
    const lbl: Record<string, string> = { so: 'Sonntag', n25: 'Nacht 25 %', n40: 'Nacht 40 %', fe: 'Feiertag' }
    for (const k of aktiv) {
      if (zielK[k] - c[k] > 30) warnungen.push(`${lbl[k]}: nur ${round2(c[k] / 60)} von ${round2(zielK[k] / 60)} h erreichbar – die echten Fahrzeiten geben nicht mehr her.`)
    }
    const zusatz = [...netById.keys()].filter((d) => istSo(d) && !echteSoSet.has(d) && (netById.get(d) || 0) > 0)
    if (zusatz.length > 0) warnungen.push(`${zusatz.length} zusätzliche(r) Sonntag(e) angesetzt: ${zusatz.join(', ')}.`)
  }

  // ---- HÖCHSTENS 6 ARBEITSTAGE AM STÜCK (§ 11 ArbZG). Bei 7 in Folge wird der
  // Tag mit den WENIGSTEN Stunden freigegeben und seine Stunden auf die übrigen
  // belegten Tage verteilt (max. 8 h/Tag). Ein Sonntag mit Zielstunden wird
  // nicht freigegeben – dann ein anderer, stundenärmster Tag. ----
  {
    const alleTage = plan.days.map((t) => t.date)
    const belegt = (d: string) => (netById.get(d) || 0) > 0
    const geschützt = (d: string) => sonntagMin > 0 && istSo(d)
    let freigegeben = 0
    for (let versuch = 0; versuch < 60; versuch++) {
      let lauf: string[] = []
      let treffer: string[] | null = null
      for (let i = 0; i <= alleTage.length; i++) {
        if (i < alleTage.length && belegt(alleTage[i])) lauf.push(alleTage[i])
        else { if (lauf.length > 6) { treffer = lauf; break }; lauf = [] }
      }
      if (!treffer) break
      const kand = treffer.filter((d) => !geschützt(d))
      if (kand.length === 0) break
      const frei = kand.reduce((a, b) => ((netById.get(a) || 0) <= (netById.get(b) || 0) ? a : b))
      let übrig = netById.get(frei) || 0
      netById.set(frei, 0)
      freigegeben++
      const ziele = alleTage.filter((d) => d !== frei && belegt(d) && !geschützt(d) && (netById.get(d) || 0) < MAX_NET_MIN)
      let g2 = 0
      while (übrig > 0 && g2++ < 10000) {
        let platziert = false
        for (const d of ziele) {
          if (übrig <= 0) break
          const nd = netById.get(d) || 0
          const add = Math.min(MAX_NET_MIN - nd, übrig, 15)
          if (add <= 0) continue
          netById.set(d, nd + add); übrig -= add; platziert = true
        }
        if (!platziert) break
      }
      if (übrig > 1) warnungen.push(`${round2(übrig / 60)} h ließen sich nach dem Freigeben eines Ruhetags nicht umverteilen – Gesamt sinkt entsprechend.`)
    }
    if (freigegeben > 0) warnungen.push(`${freigegeben} Tag(e) freigegeben für die gesetzliche Obergrenze von 6 Arbeitstagen am Stück (§ 11 ArbZG).`)
  }

  // ---- 11 h RUHEZEIT (§ 5 ArbZG) ERZWINGEN, aber stundenschonend. Je Tag gilt
  // eine rest-sichere Obergrenze: die Schicht darf höchstens so lang sein, dass
  // sie 11 h vor dem Beginn des nächsten belegten Tages endet. Überlängen werden
  // gekappt und – soweit es diese Grenzen zulassen – auf andere Tage umverteilt.
  // So bleibt die Ruhezeit garantiert UND das Gesamt wird so weit wie legal
  // möglich getroffen. Caps hängen nur an den (festen) Startzeiten; wird ein Tag
  // frei, bekommt der Vortag in der nächsten Runde mehr Spielraum. ----
  const RUHE = 11 * 60 * 60000
  const restSichererCap = (d: string, nextStart: number): number => {
    const s = startOf.get(d) ?? Date.parse(`${d}T10:00:00Z`)
    if (!Number.isFinite(nextStart)) return MAX_NET_MIN
    const grenze = nextStart - RUHE
    if (s > grenze) return 0
    let lo = 0, hi = MAX_NET_MIN
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      const end = baueSchicht(s, mid, pauseOf.get(d) ?? 30, null).endMs
      if (end <= grenze) lo = mid; else hi = mid - 1
    }
    return lo
  }
  for (let iter = 0; iter < 10; iter++) {
    const worked = [...netById.keys()].filter((d) => (netById.get(d) || 0) > 0).sort()
    if (worked.length === 0) break
    const cap = new Map<string, number>()
    for (let i = 0; i < worked.length; i++) {
      const nextStart = i + 1 < worked.length ? (startOf.get(worked[i + 1]) ?? Date.parse(`${worked[i + 1]}T10:00:00Z`)) : Infinity
      cap.set(worked[i], restSichererCap(worked[i], nextStart))
    }
    let pool = 0
    for (const d of worked) { const c = cap.get(d) ?? MAX_NET_MIN; if ((netById.get(d) || 0) > c) { pool += (netById.get(d) || 0) - c; netById.set(d, c) } }
    // Umverteilen innerhalb der rest-sicheren Kapazität (Sonntage mit Ziel zuletzt).
    const empf = worked
      .filter((d) => (netById.get(d) || 0) < (cap.get(d) ?? MAX_NET_MIN))
      .sort((a, b) => ((sonntagMin > 0 && istSo(a)) ? 1 : 0) - ((sonntagMin > 0 && istSo(b)) ? 1 : 0) || (netById.get(a) || 0) - (netById.get(b) || 0))
    for (const d of empf) {
      if (pool <= 0) break
      const add = Math.min((cap.get(d) ?? MAX_NET_MIN) - (netById.get(d) || 0), pool)
      if (add <= 0) continue
      netById.set(d, (netById.get(d) || 0) + add); pool -= add
    }
    if (pool <= 0.5 && worked.every((d) => (netById.get(d) || 0) <= (cap.get(d) ?? MAX_NET_MIN) + 0.5)) break
  }
  {
    const gesamtIst = [...netById.values()].reduce((a, b) => a + b, 0)
    if (gesamtMin - gesamtIst > 5) warnungen.push(`Wegen der 11-Stunden-Ruhezeit sind nur ${round2(gesamtIst / 60)} von ${ziel.gesamt} h planbar (die Ruhezeit hat Vorrang).`)
  }

  // Plan bauen: Tage in Datumsreihenfolge, inkl. evtl. zusätzlicher Sonntage
  // (aus „frei" wird dann „schicht").
  let prevEndMs: number | null = null
  let paidH = 0
  let nettoH = 0
  let workDays = 0
  const neueTage: PlanDay[] = plan.days.map((tag) => {
    const netMin = netById.get(tag.date) ?? 0
    if (netMin <= 0) {
      if (tag.kind === 'schicht') return { ...tag, kind: 'frei', shifts: [], hinweis: 'durch Zielvorgabe nicht belegt', ausgelassen: '' }
      return tag
    }
    const startMs = startOf.get(tag.date) ?? Date.parse(`${tag.date}T10:00:00Z`)
    const realPause = pauseOf.get(tag.date) ?? 30
    const restH = prevEndMs != null ? (startMs - prevEndMs) / H : null
    const shift = baueSchicht(startMs, netMin, realPause, restH)
    const zusatz = !echteSoSet.has(tag.date) && istSo(tag.date) && tag.kind !== 'schicht'
    prevEndMs = shift.endMs
    paidH += shift.paidH
    nettoH += shift.nettoH
    workDays++
    return { ...tag, kind: 'schicht', shifts: [shift], hinweis: [shift.hinweis, zusatz ? 'Zusatz-Sonntag (Zielvorgabe)' : ''].filter(Boolean).join(' · '), ausgelassen: '' }
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
    feiertage: (ziel.feiertage ?? []).length ? ziel.feiertage : plan.feiertage,
  }
}

/**
 * EXAKT-Planer (freie Zeiten): trifft Gesamt (netto) UND alle Zuschläge
 * (Sonntag / Nacht 25 / Nacht 40) exakt, legal und über den Monat verteilt.
 * Nutzt den bewährten manuellen Planer (erstellePlan), der die Uhrzeiten so
 * setzt, dass die §-3b-Stunden exakt stimmen. Weil erstellePlan mit der
 * bezahlten SPANNE rechnet, das Ziel aber NETTO ist, wird die Spanne so
 * nachgeführt, dass die Nettosumme das Gesamt trifft. Die echten Uber-Zeiten
 * gehen hier bewusst NICHT ein – dafür stimmen die Zahlen exakt.
 */
export function planExakt(name: string, month: string, ziel: ZielVorgabe): DriverPlan {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  const jahr = m ? Number(m[1]) : new Date().getFullYear()
  const monat1 = m ? Number(m[2]) : new Date().getMonth() + 1
  const son = Math.max(0, ziel.sonntag || 0)
  const n25 = Math.max(0, ziel.nacht25 || 0)
  const n40 = Math.max(0, ziel.nacht40 || 0)
  const fe = Math.max(0, ziel.feiertag || 0)
  const feSet = new Set(ziel.feiertage ?? [])

  // Der Kern (erstellePlan) kennt die Feiertage NICHT – er plant die übrigen
  // Zuschläge (Sonntag/Nacht) für den Netto-Rest ohne die Feiertagsstunden.
  const kernGesamt = Math.max(0, ziel.gesamt - fe)
  let bezahlt = kernGesamt
  let mr: ManualResult = erstellePlan(jahr, monat1, { bezahlt, sunday: son, n25, n40 })
  for (let i = 0; i < 10; i++) {
    const diff = kernGesamt - mr.summe.netto
    if (Math.abs(diff) < 0.05) break
    bezahlt = Math.max(0, bezahlt + diff)
    mr = erstellePlan(jahr, monat1, { bezahlt, sunday: son, n25, n40 })
  }
  const dp = manualAlsDriverPlan(name, month, mr)

  // Feiertage als freie Leinwand: Schichten, die der Kern zufällig auf einen
  // Feiertag gelegt hat, werden freigegeben (ihr Beitrag wird unten exakt neu
  // aufgebaut). So entstehen keine ungewollten Feiertagsstunden.
  if (feSet.size > 0) {
    for (const day of dp.days) {
      if (day.kind === 'schicht' && feSet.has(day.date)) { day.kind = 'frei'; day.shifts = []; day.hinweis = '' }
    }
  }

  // Zuschläge exakt nachziehen (Sonntag / Nacht 25 / Nacht 40 / Feiertag), dann
  // das Netto-Gesamt exakt einstellen, ohne die Zuschläge anzutasten.
  feinAbgleichZuschlag(dp, { sonntag: son, nacht25: n25, nacht40: n40, feiertag: fe }, feSet)
  feinAbgleichNetto(dp, Math.round(ziel.gesamt * 60), feSet)
  // Ruhezeit (§ 5) und 6-Tage-Grenze (§ 11) erzwingen – nur durch Verschieben
  // ganzer Schichten auf andere Tage GLEICHER Klasse (Werktag↔Werktag,
  // Sonntag↔Sonntag, Feiertag↔Feiertag). Uhrzeit und Netto bleiben gleich,
  // daher bleiben ALLE Zuschlagssummen exakt erhalten.
  erzwingeRuheUndSerie(dp, feSet)
  // Feiertage mitgeben, damit Vorschau/Excel die 125 %-Stunden gleich zuordnen.
  if (feSet.size > 0) dp.feiertage = [...feSet]
  return dp
}

const RUHE_MS = 11 * 3600000

/** Absolutes Start-/Endezeitfenster einer Schicht an ihrem Tag (ms). */
function absFenster(date: string, s: PlanShift): { start: number; end: number } {
  const base = Date.parse(`${date}T00:00:00Z`)
  return { start: base + s.startMin * 60000, end: base + s.endMin * 60000 }
}

/**
 * „Kosten" eines Plans für die Legalität: Anzahl Ruhe-Verstöße (< 11 h zwischen
 * zeitlich benachbarten Schichten) stark gewichtet, plus Tage über der 6-Tage-
 * Grenze. 0 = voll gesetzeskonform.
 */
function legalKosten(dp: DriverPlan): number {
  const tage = dp.days.filter((d) => d.kind === 'schicht' && d.shifts.length)
  const fenster = tage.map((d) => absFenster(d.date, d.shifts[0])).sort((a, b) => a.start - b.start)
  let ruhe = 0
  for (let i = 1; i < fenster.length; i++) {
    if (fenster[i].start - fenster[i - 1].end < RUHE_MS - 1000) ruhe++
  }
  // längster Lauf aufeinanderfolgender Kalendertage mit Schicht
  const belegt = new Set(tage.map((d) => d.date))
  let lauf = 0, maxLauf = 0
  for (const d of dp.days) { if (belegt.has(d.date)) { lauf++; maxLauf = Math.max(maxLauf, lauf) } else lauf = 0 }
  return ruhe * 100 + Math.max(0, maxLauf - 6) * 10
}

/**
 * Erzwingt § 5 (11 h Ruhe) und § 11 (höchstens 6 Arbeitstage am Stück), indem
 * ganze Schichten auf freie Tage DERSELBEN Klasse verschoben werden. Da Uhrzeit
 * und Netto unverändert bleiben und die Tagklasse (Werktag/Sonntag/Feiertag)
 * gleich bleibt, ändern sich Gesamt und ALLE Zuschläge nicht. Lokale Suche:
 * jeweils der Zug, der die Legal-Kosten am stärksten senkt, bis 0 oder nichts
 * mehr hilft.
 */
function erzwingeRuheUndSerie(dp: DriverPlan, feSet: Set<string>): void {
  const istSo = (d: string) => weekdayIndex(d) === 0
  const klasse = (d: string): 'so' | 'fe' | 'wd' => (istSo(d) ? 'so' : feSet.has(d) ? 'fe' : 'wd')

  // Schicht von Tag A nach Tag B umhängen (B muss frei sein). Uhrzeit bleibt,
  // nur das Datum (und die abgeleiteten ms/date-Felder) wandern mit.
  const verschiebe = (from: PlanDay, to: PlanDay) => {
    const s = from.shifts[0]
    const base = Date.parse(`${to.date}T00:00:00Z`)
    const neu: PlanShift = { ...s, date: to.date, startMs: base + s.startMin * 60000, endMs: base + s.endMin * 60000 }
    to.kind = 'schicht'; to.shifts = [neu]; to.hinweis = from.hinweis
    from.kind = 'frei'; from.shifts = []; from.hinweis = ''
  }

  for (let iter = 0; iter < 400; iter++) {
    const kosten = legalKosten(dp)
    if (kosten === 0) break
    const belegt = dp.days.filter((d) => d.kind === 'schicht' && d.shifts.length)
    const freiProKlasse = (cls: string) => dp.days.filter((d) => d.kind !== 'schicht' && klasse(d.date) === cls)
    let best: { from: PlanDay; to: PlanDay; kosten: number } | null = null
    for (const from of belegt) {
      const cls = klasse(from.date)
      for (const to of freiProKlasse(cls)) {
        // probeweise verschieben, Kosten messen, zurück.
        const sFrom = from.shifts[0], hFrom = from.hinweis
        verschiebe(from, to)
        const k = legalKosten(dp)
        // rückgängig
        const base = Date.parse(`${from.date}T00:00:00Z`)
        from.kind = 'schicht'; from.shifts = [{ ...to.shifts[0], date: from.date, startMs: base + sFrom.startMin * 60000, endMs: base + sFrom.endMin * 60000 }]; from.hinweis = hFrom
        to.kind = 'frei'; to.shifts = []; to.hinweis = ''
        if (k < (best?.kosten ?? kosten)) best = { from, to, kosten: k }
      }
    }
    if (!best) break // lokales Minimum – kein verbessernder Zug
    verschiebe(best.from, best.to)
  }

  // Ruhezeit-Felder und Hinweise nach dem Umhängen neu setzen (Datumsreihenfolge).
  const sortiert = dp.days.filter((d) => d.kind === 'schicht' && d.shifts.length).sort((a, b) => a.date.localeCompare(b.date))
  let prevEnd: number | null = null
  for (const d of sortiert) {
    const s = d.shifts[0]
    const f = absFenster(d.date, s)
    const restH = prevEnd != null ? (f.start - prevEnd) / H : null
    const notes = (s.hinweis || '').split(' · ').filter((x) => x && !/Ruhezeit/.test(x))
    if (restH != null && restH + 1e-6 < 11) notes.push(`Ruhezeit ${restH.toFixed(2).replace('.', ',')} h, unter 11 h`)
    s.restH = restH == null ? null : round2(restH)
    s.hinweis = notes.join(' · ')
    d.hinweis = s.hinweis
    prevEnd = f.end
  }
  const kostRest = legalKosten(dp)
  if (kostRest > 0) {
    dp.weekNotes = ['Hinweis: 11-h-Ruhe/6-Tage-Grenze ließ sich nicht an allen Tagen einhalten, ohne die Zielzahlen zu verändern.', ...dp.weekNotes]
  }
}

/** Pure Beitragsstunden (Minuten) einer Schicht an einem Datum: welche Zuschläge. */
type ZusM = { so: number; n25: number; n40: number; fe: number }
function zusDesTages(s: PlanShift, feSet: Set<string>): ZusM {
  const h = computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.pauseAt }, feSet)
  return { so: h.sunday50 * 60, n25: h.night25 * 60, n40: h.night40 * 60, fe: h.holiday125 * 60 }
}

/**
 * Setzt eine reine Beitrags-Schicht (ein einzelner Zuschlagstyp) mit `netMin`
 * Netto-Minuten auf einen freien Tag. Zeitfenster nach Typ:
 *   • n40  → endet 04:00 (Arbeit nur 00–04 Uhr)
 *   • n25  → 20:00 + netMin (Arbeit nur 20–24 Uhr)
 *   • so   → 08:00 (ganzer Sonntag zählt 50 %)
 *   • fe   → 08:00 an einem Feiertag (ganzer Feiertag zählt 125 %)
 * Gibt true zurück, wenn der Block gesetzt wurde.
 */
function setzeBlock(day: PlanDay, typ: 'so' | 'n25' | 'n40' | 'fe', netMin: number): boolean {
  if (netMin <= 0) return false
  const tag0 = Date.parse(`${day.date}T00:00:00Z`)
  let startMin: number
  if (typ === 'n40') startMin = Math.max(0, 240 - netMin) // endet 04:00
  else if (typ === 'n25') startMin = 20 * 60 // 20:00
  else startMin = 8 * 60 // Sonntag / Feiertag: Tagschicht 08:00
  const shift = baueSchicht(tag0 + startMin * 60000, netMin, 0, null)
  day.kind = 'schicht'
  day.shifts = [shift]
  day.hinweis = ''
  return true
}

/**
 * Zieht unter-erfüllte Zuschläge exakt nach. Der Kern-Planer erzeugt nie mehr
 * als die Zielmenge (kein Überziehen), daher sind nur Fehlmengen zu decken.
 * Jede Fehlmenge wird als reiner Block auf freie Tage gelegt – n40 ≤ 225 min
 * je Tag (Start ≥ 00:15, nie 00:00), n25 ≤ 240, Sonntag/Feiertag ≤ 480 Netto.
 */
function feinAbgleichZuschlag(dp: DriverPlan, ziel: { sonntag: number; nacht25: number; nacht40: number; feiertag: number }, feSet: Set<string>): void {
  const summe = (): ZusM => {
    const a: ZusM = { so: 0, n25: 0, n40: 0, fe: 0 }
    for (const d of dp.days) for (const s of d.shifts) { const z = zusDesTages(s, feSet); a.so += z.so; a.n25 += z.n25; a.n40 += z.n40; a.fe += z.fe }
    return a
  }
  const frei = () => dp.days.filter((d) => d.kind !== 'schicht')
  const istSo = (d: string) => weekdayIndex(d) === 0
  const nachbarBelegt = (idx: number) =>
    (idx > 0 && dp.days[idx - 1].kind === 'schicht') || (idx + 1 < dp.days.length && dp.days[idx + 1].kind === 'schicht')

  // Freie Tage bevorzugt ohne belegten Nachbarn (schont die 11-h-Ruhe).
  const waehleFreie = (pred: (d: PlanDay) => boolean): PlanDay[] => {
    const idx = new Map(dp.days.map((d, i) => [d.date, i]))
    const kand = frei().filter(pred)
    return kand.sort((a, b) => (nachbarBelegt(idx.get(a.date)!) ? 1 : 0) - (nachbarBelegt(idx.get(b.date)!) ? 1 : 0) || a.date.localeCompare(b.date))
  }

  // Feiertag zuerst: nur auf Feiertags-Daten (die sind oben freigegeben worden).
  let defFe = Math.round(ziel.feiertag * 60) - Math.round(summe().fe)
  for (const day of waehleFreie((d) => feSet.has(d.date) && !istSo(d.date))) {
    if (defFe <= 0) break
    const m = Math.min(MAX_NET_MIN, defFe)
    if (setzeBlock(day, 'fe', m)) defFe -= m
  }
  // Nacht 40 %: reine 00–04-Blöcke, ≤ 225 min/Tag.
  let def40 = Math.round(ziel.nacht40 * 60) - Math.round(summe().n40)
  for (const day of waehleFreie((d) => !istSo(d.date) && !feSet.has(d.date))) {
    if (def40 <= 0) break
    const m = Math.min(225, def40)
    if (setzeBlock(day, 'n40', m)) def40 -= m
  }
  // Nacht 25 %: reine 20–24-Blöcke, ≤ 240 min/Tag.
  let def25 = Math.round(ziel.nacht25 * 60) - Math.round(summe().n25)
  for (const day of waehleFreie((d) => !istSo(d.date) && !feSet.has(d.date))) {
    if (def25 <= 0) break
    const m = Math.min(240, def25)
    if (setzeBlock(day, 'n25', m)) def25 -= m
  }
  // Sonntag: reine Tagschichten auf freie Sonntage, ≤ 480 Netto/Tag.
  let defSo = Math.round(ziel.sonntag * 60) - Math.round(summe().so)
  for (const day of waehleFreie((d) => istSo(d.date) && !feSet.has(d.date))) {
    if (defSo <= 0) break
    const m = Math.min(MAX_NET_MIN, defSo)
    if (setzeBlock(day, 'so', m)) defSo -= m
  }

  const warn: string[] = []
  if (defFe > 1) warn.push(`Feiertag: ${round2(defFe / 60)} h konnten nicht gesetzt werden (keine freien Feiertage mehr).`)
  if (def40 > 1) warn.push(`Nacht 40 %: ${round2(def40 / 60)} h konnten nicht gesetzt werden (keine freien Werktage mehr).`)
  if (def25 > 1) warn.push(`Nacht 25 %: ${round2(def25 / 60)} h konnten nicht gesetzt werden (keine freien Werktage mehr).`)
  if (defSo > 1) warn.push(`Sonntag: ${round2(defSo / 60)} h konnten nicht gesetzt werden (keine freien Sonntage mehr).`)
  if (warn.length) dp.weekNotes = [...warn, ...dp.weekNotes]
}

/**
 * Netto-Gesamt exakt treffen, ohne die Zuschläge anzutasten: nur ZUSCHLAGSFREIE
 * (reine Tages-)Schichten werden in der Länge angepasst. Reicht die vorhandene
 * Kapazität nicht, werden zusätzliche neutrale Werktage angesetzt.
 */
function feinAbgleichNetto(dp: DriverPlan, zielMin: number, feSet: Set<string> = new Set()): void {
  const istNeutral = (s: PlanShift): boolean => {
    const h = computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.pauseAt }, feSet)
    return h.sunday50 < 0.01 && h.night25 < 0.01 && h.night40 < 0.01 && h.holiday125 < 0.01
  }
  const netMin = () => Math.round(dp.days.reduce((a, d) => a + d.shifts.reduce((x, s) => x + s.nettoH, 0), 0) * 60)
  let diff = zielMin - netMin()

  // Reine Tagschicht (08:00) der gewünschten Netto-Länge. 08:00 + höchstens
  // 8 h Netto + Pause endet spätestens 16:30 – also nie in 04–06, 20–24 oder
  // 00–04, womit die Schicht garantiert ZUSCHLAGSFREI bleibt.
  const neutralerTag = (date: string, netM: number): PlanShift =>
    baueSchicht(Date.parse(`${date}T08:00:00Z`), netM, 0, null)

  // 1) vorhandene neutrale Tages-Schichten anpassen. Immer über neutralerTag,
  //    damit eine wachsende Schicht nicht in ein Zuschlagsfenster rutscht.
  for (const day of dp.days) {
    if (Math.abs(diff) < 1) break
    if (day.kind !== 'schicht' || day.shifts.length !== 1) continue
    const s = day.shifts[0]
    if (!istNeutral(s)) continue
    const cur = Math.round(s.nettoH * 60)
    const neu = Math.max(0, Math.min(MAX_NET_MIN, cur + diff))
    if (neu === cur) continue
    diff -= neu - cur
    if (neu <= 0) { day.kind = 'frei'; day.shifts = []; day.hinweis = '' }
    else day.shifts = [neutralerTag(day.date, neu)]
  }
  // 2) fehlt noch etwas, neutrale Werktage auf freien Tagen ergänzen.
  if (diff > 1) {
    for (const day of dp.days) {
      if (diff < 1) break
      if (day.kind === 'schicht') continue
      if (weekdayIndex(day.date) === 0) continue // Sonntag neutral vermeiden
      if (feSet.has(day.date)) continue // Feiertag nicht neutral belegen (würde 125 % erzeugen)
      const add = Math.min(MAX_NET_MIN, diff)
      day.kind = 'schicht'
      day.shifts = [neutralerTag(day.date, add)]
      day.hinweis = ''
      diff -= add
    }
  }
  // Summen neu setzen.
  let paidH = 0, nettoH = 0, workDays = 0
  for (const d of dp.days) {
    if (d.kind !== 'schicht') continue
    for (const s of d.shifts) { paidH += s.paidH; nettoH += s.nettoH }
    if (d.shifts.length) workDays++
  }
  dp.paidH = round2(paidH)
  dp.nettoH = round2(nettoH)
  dp.workDays = workDays
  dp.freeDays = dp.days.filter((d) => d.kind !== 'schicht').length
}

/** Alle Kalendertage eines Monats "YYYY-MM" als ISO-Datum. */
function tageImMonat(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  if (!m) return []
  const out: string[] = []
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  while (d.getUTCMonth() === Number(m[2]) - 1) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

function manualAlsDriverPlan(name: string, month: string, mr: ManualResult): DriverPlan {
  let paidH = 0
  let nettoH = 0
  let workDays = 0
  // Aktive Tage des Kerns nach Datum; der Rest des Monats bleibt als freier Tag
  // stehen, damit die Zuschlags- und Netto-Feinabstimmung eine Leinwand hat.
  const aktiv = new Map(mr.tage.map((t) => [t.date, t]))
  const alle = tageImMonat(month)
  const quelle = alle.length ? alle : mr.tage.map((t) => t.date)
  const days: PlanDay[] = quelle.map((date) => {
    const weekday = weekdayIndex(date)
    const t = aktiv.get(date)
    if (!t || !t.aktiv || t.startMin == null || t.endMin == null || t.bezahlt <= 0) {
      return { date, weekday, kind: 'frei', shifts: [], hinweis: '', ausgelassen: '' }
    }
    const tag0 = Date.parse(`${t.date}T00:00:00Z`)
    const shift: PlanShift = {
      date: t.date,
      startMs: tag0 + t.startMin * 60000,
      endMs: tag0 + t.endMin * 60000,
      startMin: t.startMin,
      endMin: t.endMin,
      pauseH: round2(t.pause / 60),
      pauseAt: t.breaks,
      paidH: round2(t.bezahlt),
      nettoH: round2(t.netto),
      restH: t.ruhe,
      hinweis: t.warnung ?? '',
    }
    paidH += shift.paidH
    nettoH += shift.nettoH
    workDays++
    return { date: t.date, weekday, kind: 'schicht', shifts: [shift], hinweis: shift.hinweis, ausgelassen: '' }
  })
  return {
    name,
    month,
    days,
    paidH: round2(paidH),
    nettoH: round2(nettoH),
    workDays,
    freeDays: days.filter((d) => d.kind !== 'schicht').length,
    ruheTage: 0,
    violations: 0,
    weekNotes: mr.warnings,
  }
}
