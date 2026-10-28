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
  // Abgleich sie oft mit denselben Werten abfragt.
  const soMemo = new Map<string, number>()
  const sonntagMinOf = (date: string, n: number): number => {
    if (n <= 0) return 0
    const key = `${date}|${n}`
    const c = soMemo.get(key)
    if (c != null) return c
    const startMs = startOf.get(date) ?? Date.parse(`${date}T10:00:00Z`)
    const pause = pauseOf.get(date) ?? 30
    const sh = baueSchicht(startMs, n, pause, null)
    const h = computeShiftHours({ date: sh.date, startMin: sh.startMin, endMin: sh.endMin, breaks: sh.pauseAt })
    const v = Math.round(h.sunday50 * 60)
    soMemo.set(key, v)
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

  // ---- SONNTAG (nur bei Vorgabe): tatsächliche Sonntagsstunden (ab 00:00,
  // Samstagnacht zählt mit) aufs Ziel bringen, durch Umschichten zwischen Tagen
  // (Gesamt bleibt konstant). Reichen die echten Sonntage nicht, werden
  // zusätzliche Kalender-Sonntage angesetzt. ----
  if (sonntagMin > 0) {
    for (const d of alleSonntage) {
      if (!startOf.has(d)) { startOf.set(d, Date.parse(`${d}T10:00:00Z`)); pauseOf.set(d, 30) }
      if (!netById.has(d)) netById.set(d, 0)
    }
    const sundayNow = () => [...netById.keys()].reduce((a, d) => a + sonntagMinOf(d, netById.get(d) || 0), 0)
    for (const step of [15, 5, 1]) {
      let guard = 0
      while (guard++ < 8000) {
        const diff = sonntagMin - sundayNow()
        if (Math.abs(diff) <= 0.5) break
        if (diff > 0) {
          let empf: string | null = null; let best = 0
          for (const d of netById.keys()) {
            if ((netById.get(d) || 0) + step > MAX_NET_MIN) continue
            const g = sonntagMinOf(d, (netById.get(d) || 0) + step) - sonntagMinOf(d, netById.get(d) || 0)
            if (g > best) { best = g; empf = d }
          }
          if (!empf || best <= 0) break
          let geber: string | null = null; let verlust = Infinity; let gNet = -1
          for (const d of netById.keys()) {
            if (d === empf) continue
            const nd = netById.get(d) || 0
            if (nd < step) continue
            const l = sonntagMinOf(d, nd) - sonntagMinOf(d, nd - step)
            if (l < verlust || (l === verlust && nd > gNet)) { verlust = l; geber = d; gNet = nd }
          }
          if (!geber || best - verlust <= 0) break
          netById.set(empf, (netById.get(empf) || 0) + step)
          netById.set(geber, (netById.get(geber) || 0) - step)
        } else {
          let geber: string | null = null
          for (const d of netById.keys()) { if (istSo(d) && (netById.get(d) || 0) >= step) { geber = d; break } }
          let empf: string | null = null; let eNet = Infinity
          for (const d of netById.keys()) {
            if (istSo(d)) continue
            const nd = netById.get(d) || 0
            if (nd + step > MAX_NET_MIN) continue
            if (nd < eNet) { eNet = nd; empf = d }
          }
          if (!geber || !empf) break
          netById.set(geber, (netById.get(geber) || 0) - step)
          netById.set(empf, (netById.get(empf) || 0) + step)
        }
      }
    }
    const erreicht = sundayNow()
    if (sonntagMin - erreicht > 30) warnungen.push(`Sonntag: nur ${round2(erreicht / 60)} von ${ziel.sonntag} h erreichbar (durch die vorhandenen Tage/Sonntage begrenzt).`)
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

  // ---- 11 h RUHEZEIT zwischen Schichten (§ 5 ArbZG) ERZWINGEN. Endet eine
  // Schicht weniger als 11 h vor dem Beginn der nächsten, wird sie so weit
  // gekürzt, dass 11 h erreicht sind; die gekürzten Stunden wandern auf andere
  // belegte Tage mit Platz. Lässt es sich nicht unterbringen, sinkt das Gesamt
  // entsprechend (mit Warnung) – die Ruhezeit hat Vorrang. ----
  {
    const RUHE = 11 * 60 * 60000
    let verlust = 0
    let gelöst = false
    for (let iter = 0; iter < 160; iter++) {
      const worked = [...netById.keys()].filter((d) => (netById.get(d) || 0) > 0).sort()
      let prevEnd: number | null = null
      let prevDate: string | null = null
      let konflikt: { prev: string; cur: string } | null = null
      for (const d of worked) {
        const startMs = startOf.get(d) ?? Date.parse(`${d}T10:00:00Z`)
        if (prevEnd != null && startMs - prevEnd < RUHE - 1) { konflikt = { prev: prevDate as string, cur: d }; break }
        const sh = baueSchicht(startMs, netById.get(d) || 0, pauseOf.get(d) ?? 30, null)
        prevEnd = sh.endMs
        prevDate = d
      }
      if (!konflikt) { gelöst = true; break }
      const prevStart = startOf.get(konflikt.prev) as number
      const curStart = startOf.get(konflikt.cur) as number
      const grenze = curStart - RUHE // die frühere Schicht muss spätestens hier enden
      let lo = 0
      let hi = netById.get(konflikt.prev) || 0
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        const end = baueSchicht(prevStart, mid, pauseOf.get(konflikt.prev) ?? 30, null).endMs
        if (end <= grenze) lo = mid; else hi = mid - 1
      }
      const cut = (netById.get(konflikt.prev) || 0) - lo
      if (cut <= 0) break // lässt sich nicht weiter kürzen
      netById.set(konflikt.prev, lo)
      // gekürzte Stunden umverteilen: andere belegte Tage, wenigste zuerst,
      // max 8 h; Sonntage mit Ziel möglichst meiden, um sie nicht zu stören.
      let übrig = cut
      const empfänger = [...netById.keys()]
        .filter((d) => d !== konflikt.prev && (netById.get(d) || 0) > 0 && (sonntagMin > 0 ? !istSo(d) : true))
        .sort((a, b) => (netById.get(a) || 0) - (netById.get(b) || 0))
      for (const d of empfänger) {
        if (übrig <= 0) break
        const nd = netById.get(d) || 0
        const add = Math.min(MAX_NET_MIN - nd, übrig)
        if (add <= 0) continue
        netById.set(d, nd + add)
        übrig -= add
      }
      verlust += übrig
    }
    if (verlust > 1) warnungen.push(`${round2(verlust / 60)} h ließen sich wegen der 11-Stunden-Ruhezeit nicht unterbringen – Gesamt sinkt entsprechend.`)
    if (!gelöst) warnungen.push('Die 11-Stunden-Ruhezeit ließ sich nicht an allen Tagen einhalten – bitte die Zeiten prüfen.')
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
  }
}
