// Präzise, deterministische Schichtverteilung – trifft die eingegebenen Ziele
// EXAKT (per Konstruktion), statt sie wie der heuristische Verteiler
// (hoursMode.ts) nur bestmöglich anzunähern.
//
// Idee: Jede Zuschlagsart bekommt EIGENE Schichten, die ausschließlich in ihr
// Zeitfenster/ihren Tag fallen – ohne Überschneidung:
//   • Sonntagsstunden  -> Tagschichten AN SONNTAGEN (06–20 Uhr, nie im Nachtfenster)
//   • Nacht 40 % (00–04) -> Schichten im Fenster 00:00–04:00 an Werktagen
//   • Nacht 25 % (20–24) -> Schichten im Fenster 20:00–24:00 an Werktagen
//   • Rest (normale Std)  -> Tagschichten (06–20 Uhr) an Werktagen, kein Zuschlag
// Dadurch zählt jede gearbeitete Stunde genau einmal in die gewünschte Spalte;
// die Summen treffen die Eingabe exakt. Die bezahlte Gesamtsumme (Netto + Pause)
// wird über die Summe der Schicht-Spannen minutengenau auf den Zielwert gebracht.
//
// REALISTISCHE VARIATION (deterministisch, seed-basiert – Vorschau und Excel
// sind daher identisch): Startzeiten, Pausenlängen und die Netto-Länge normaler
// Schichten variieren innerhalb erlaubter Grenzen, damit der Plan nicht
// schematisch (immer 08:00–16:30 / 30 Min) wirkt. Die Variation ist so gebaut,
// dass die HARTEN REGELN unangetastet bleiben:
//   • Pro Schicht wird die bezahlte SPANNE (Beginn→Ende) festgelegt; variiert
//     wird nur, WIE sie sich auf Netto und Pause aufteilt. Dadurch bleibt die
//     bezahlte Gesamtsumme exakt.
//   • Die Netto-Stunden der Zuschlags-Schichten (Sonntag/Nacht) bleiben fix –
//     also bleiben Sonntag- und Nachtstunden exakt.
//   • Startzeiten verschieben die Schicht nur INNERHALB ihres zuschlagssicheren
//     Fensters – die Zuschlags-Einstufung jeder Stunde ändert sich nicht.
//   • Max. 8 Netto-Std/Tag und die Pausen-/Ruhezeitregeln gelten weiter.
//
// Kompromiss: eine Schicht pro Tag. Lassen sich nicht alle Stunden unterbringen
// (zu wenige passende Tage) oder würde die Ruhezeit < 11 h unterschritten, wird
// die betroffene Schicht WEGGELASSEN und als Warnung mit Rest-Abweichung
// ausgewiesen (die Vorschau zeigt Ziel vs. Ist für alle vier Werte).

export type ExactShift = {
  date: string
  startMin: number
  endMin: number
  breakMinutes: number
  breaks: { start: number; end: number }[]
  netHours: number
}
export type ExactResult = { shifts: ExactShift[]; warnings: string[] }

const MIN_REST_MIN = 11 * 60 // § 5 ArbZG
const MAX_NET = 8 // harte Obergrenze: nie mehr als 8 Netto-Std/Tag (auch sonntags)
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// Zuschlagssichere Tagfenster (keine Überschneidung mit den Nachtfenstern
// 00–04 / 04–06 / 20–24): eine Tagschicht muss komplett zwischen 06:00 und
// 20:00 liegen. Zusätzlich halten wir das Ende ≤ 19:00 und den Start ≥ 06:00,
// damit die Ruhezeit zum nächsten frühen Tag (ab 06:00) ≥ 11 h bleibt.
const DAY_WINDOW_START = 6 * 60 // 06:00 – früher wäre 25-%-Nachtfenster (04–06)
const DAY_START_LATEST = 10 * 60 // 10:00 – spätester Start für einen „frühen" Dienst
const DAY_END_LATEST = 19 * 60 // 19:00 – schützt die 11-h-Ruhezeit

/** Gesetzliche Mindestpause (§ 4 ArbZG) nach Arbeitszeit (Minuten). */
function legalBreak(workMin: number): number {
  if (workMin > 9 * 60) return 45
  if (workMin > 6 * 60) return 30
  return 0
}

/** Kleiner, deterministischer Pseudo-Zufall (mulberry32 auf FNV-Hash des Seeds). */
function seededRand(seed: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  let t = (h += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
/** Wählt deterministisch einen Wert aus `arr` anhand des Seeds. */
function pick<T>(arr: T[], seed: string): T {
  return arr[Math.min(arr.length - 1, Math.floor(seededRand(seed) * arr.length))]
}

/** Schicht ab `startMin`, `net` Netto-Std, feste Pause `brk` (Min.) in der Mitte. */
function makeShift(date: string, startMin: number, net: number, brk: number): ExactShift {
  const workMin = Math.max(0, Math.round(net * 60))
  const half = Math.round(workMin / 2)
  const breaks = brk > 0 ? [{ start: half, end: half + brk }] : []
  return { date, startMin, endMin: startMin + workMin + brk, breakMinutes: brk, breaks, netHours: workMin / 60 }
}

/**
 * Teilt eine bezahlte SPANNE `span` (Minuten) realistisch in Netto + Pause auf,
 * OHNE die Spanne zu verändern (damit die bezahlte Summe exakt bleibt).
 * Variiert die Pause in 15-Min-Schritten; Netto bleibt dabei zwischen 6 und 8 h
 * (bzw. = Spanne, wenn die Spanne ≤ 6 h ist – dann ohne Pause).
 */
function splitSpan(span: number, seed: string): { net: number; brk: number } {
  if (span <= 6 * 60) return { net: span / 60, brk: 0 } // ≤ 6 h: keine Pflichtpause
  // Pause so wählen, dass Netto in [6 h, 8 h] bleibt: brk ∈ [span−8h, span−6h] ∩ [30, 120]
  const minBrk = Math.max(30, span - MAX_NET * 60)
  const maxBrk = Math.min(120, span - 6 * 60)
  const steps: number[] = []
  for (let b = Math.ceil(minBrk / 15) * 15; b <= maxBrk; b += 15) steps.push(b)
  const brk = steps.length ? pick(steps, seed) : Math.max(30, Math.round(minBrk))
  return { net: (span - brk) / 60, brk }
}

/** Startzeit einer Tagschicht (Spanne `span`) deterministisch im Fenster 06–10 Uhr. */
function dayStart(span: number, seed: string): number {
  const latest = Math.min(DAY_START_LATEST, DAY_END_LATEST - span, 20 * 60 - span)
  if (latest <= DAY_WINDOW_START) return DAY_WINDOW_START
  const steps: number[] = []
  for (let s = DAY_WINDOW_START; s <= latest; s += 15) steps.push(s)
  return pick(steps, seed)
}
/** Startzeit einer Nachtschicht im Fenster [`winStart`, `winEnd`] (Spanne `span`). */
function nightStart(winStart: number, winEnd: number, span: number, seed: string): number {
  const latest = winEnd - span
  if (latest <= winStart) return winStart
  const steps: number[] = []
  for (let s = winStart; s <= latest; s += 15) steps.push(s)
  return pick(steps, seed)
}

type Spec = { cat: 'sun' | 'n40' | 'n25' | 'norm'; net: number; brk: number }

function monthDays(year: number, month1: number): { iso: string; dow: number }[] {
  const out: { iso: string; dow: number }[] = []
  const d = new Date(year, month1 - 1, 1)
  while (d.getMonth() === month1 - 1) {
    out.push({ iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, dow: d.getDay() })
    d.setDate(d.getDate() + 1)
  }
  return out
}

/**
 * Baut den exakten Plan. `bezahlt`/`sunday`/`n25`/`n40` sind die Zielwerte
 * (bezahlt = Beginn→Ende inkl. Pause; die drei Zuschläge als reine Arbeitszeit).
 */
export function verteileExakt(
  year: number, month1: number,
  ziel: { bezahlt: number; sunday: number; n25: number; n40: number }
): ExactResult {
  const warnings: string[] = []
  const bezahlt = Math.max(0, ziel.bezahlt)
  const sunday = Math.max(0, ziel.sunday)
  const n25 = Math.max(0, ziel.n25)
  const n40 = Math.max(0, ziel.n40)
  if (bezahlt <= 0) return { shifts: [], warnings }

  const tage = monthDays(year, month1)
  const nSun = tage.filter((t) => t.dow === 0).length

  // 1) Zuschlag-Schichten als Spezifikationen bauen (Netto = Ziel, keine
  //    Überschneidung). Höchstens 8 Netto-Std/Tag – auch an Sonntagen;
  //    Nachtfenster sind ohnehin ≤ 4 h (00–04 bzw. 20–24).
  //    Sonntags-Kapazität: nur so viele Sonntagsstunden wie Sonntage × 8 Std.
  //    Überzählige werden zu NORMALEN Stunden (Gesamtsumme bleibt exakt), mit
  //    klarer Warnung – Sonntag hat Vorrang, aber nicht über die 8-Std-Grenze
  //    und die Zahl der Sonntage hinaus.
  const sundayCap = Math.min(sunday, nSun * MAX_NET)
  if (round2(sunday - sundayCap) > 0.0001) {
    warnings.push(`Sonntag: nur ${n2(sundayCap)} von ${n2(sunday)} Std möglich (nur ${nSun} Sonntage × max. 8 Std) – die übrigen ${n2(sunday - sundayCap)} Std werden als normale Stunden verplant.`)
  }
  // Zuschlag-Schichten: Netto FIX (= exakte Ziele), Pause = gesetzliche Pflicht.
  // (Die Pause dieser Schichten zu variieren würde nur die bezahlte Spanne
  // ändern; sie wird über die normalen Schichten ohnehin exakt ausgeglichen –
  // wir halten sie hier schlicht, die Variation steckt in den normalen Diensten.)
  const sunSpecs: Spec[] = []
  for (let rem = sundayCap; rem > 0.0001;) { const net = Math.min(rem, MAX_NET); sunSpecs.push({ cat: 'sun', net, brk: legalBreak(net * 60) }); rem = round2(rem - net) }
  const n40Specs: Spec[] = []
  for (let rem = n40; rem > 0.0001;) { const net = Math.min(rem, 4); n40Specs.push({ cat: 'n40', net, brk: 0 }); rem = round2(rem - net) }
  const n25Specs: Spec[] = []
  for (let rem = n25; rem > 0.0001;) { const net = Math.min(rem, 4); n25Specs.push({ cat: 'n25', net, brk: 0 }); rem = round2(rem - net) }

  // 2) Normale Schichten füllen die restliche bezahlte Zeit auf. Wir legen
  //    zuerst die SPANNEN fest (volle 8,5-h-Blöcke + ein Rest), damit die
  //    bezahlte Summe exakt stimmt; erst danach wird jede Spanne realistisch in
  //    Netto + Pause aufgeteilt (splitSpan) – das ändert die Spanne nicht.
  const spanOf = (s: Spec) => Math.round(s.net * 60) + s.brk
  const fixSpan = [...sunSpecs, ...n40Specs, ...n25Specs].reduce((a, s) => a + spanOf(s), 0)
  let restSpan = Math.round(bezahlt * 60) - fixSpan
  const FULL_SPAN = MAX_NET * 60 + 30 // 8 h Netto + 30 Min Pause = 510 Min, max. darstellbare Einzel-Spanne
  const normSpecs: Spec[] = []
  if (restSpan < 0) {
    warnings.push('Die Zuschlagsstunden ergeben allein schon mehr bezahlte Zeit als die eingegebene Gesamtsumme – bitte Gesamt-Std erhöhen oder Zuschläge senken.')
  } else {
    const spans: number[] = []
    while (restSpan > FULL_SPAN) { spans.push(FULL_SPAN); restSpan -= FULL_SPAN }
    if (restSpan > 0.5) spans.push(Math.round(restSpan))
    spans.forEach((span, i) => {
      const { net, brk } = splitSpan(span, `norm-${year}-${month1}-${i}-${span}`)
      if (net > 0.01) normSpecs.push({ cat: 'norm', net, brk })
    })
  }

  // 3) Spezifikationen auf Tage verteilen – eine Schicht pro Tag, Ruhezeit
  //    ≥ 11 h (§ 5 ArbZG) BEIDSEITIG (zur vorigen UND zur nächsten Schicht).
  //
  //    SONNTAG HAT VORRANG: Sonntagsschichten werden ZUERST auf alle Sonntage
  //    gelegt (Sonntage liegen ≥ 7 Tage auseinander, kollidieren also nie). Erst
  //    danach werden die Werktagsschichten (Nacht + Rest) um die Sonntage herum
  //    verteilt. Dadurch kann eine späte Samstag-Nachtschicht (20–24 Uhr, endet
  //    So 00:00) den Sonntagsdienst nicht mehr „verdrängen" – die Nachtschicht
  //    weicht stattdessen auf einen anderen Werktag aus.
  const dayMs = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const REST = MIN_REST_MIN * 60000
  const placed: { s: number; e: number }[] = []
  const restOK = (s: number, e: number) => !placed.some((p) => s < p.e + REST && p.s < e + REST)

  const shifts: ExactShift[] = []
  const place = (iso: string, startMin: number, spec: Spec, span: number): boolean => {
    const s = dayMs(iso) + startMin * 60000
    const e = dayMs(iso) + (startMin + span) * 60000
    if (!restOK(s, e)) return false
    shifts.push(makeShift(iso, startMin, spec.net, spec.brk))
    placed.push({ s, e })
    return true
  }

  // 3a) Sonntage zuerst.
  const sunQ: Spec[] = [...sunSpecs]
  for (const t of tage) {
    if (t.dow !== 0 || sunQ.length === 0) continue
    const spec = sunQ[0]; const span = spanOf(spec)
    if (place(t.iso, dayStart(span, `s-${t.iso}`), spec, span)) sunQ.shift()
  }

  // 3b) Nacht-Schichten – BEVORZUGT auf Freitag & Samstag (Wochenend-Abend-/
  //     Nachtabdeckung). Die Nachtstunden sind durch das Ziel fix; wir steuern
  //     nur, WANN sie liegen: zuerst Fr/Sa (20–24 bzw. 00–04 Uhr = „Spätschicht
  //     18–05"), dann die übrigen Werktage. Mehr Abend-/Nachtabdeckung als die
  //     eingegebenen Nachtstunden ist im Exakt-Modell nicht möglich, ohne die
  //     Nachtziele zu verändern (18–05 Uhr IST Zuschlagszeit).
  const nachtQ: Spec[] = [...n40Specs, ...n25Specs] // n40 vor n25 = Priorität
  const normQ: Spec[] = [...normSpecs]
  const used = new Set<string>()
  const werktage = tage.filter((t) => t.dow !== 0)
  const istWE = (dow: number) => dow === 5 || dow === 6 // Freitag / Samstag
  // Fr/Sa zuerst, dann restliche Werktage – beide Gruppen in Datumsreihenfolge.
  const nachtReihenfolge = [...werktage.filter((t) => istWE(t.dow)), ...werktage.filter((t) => !istWE(t.dow))]
  for (const t of nachtReihenfolge) {
    if (nachtQ.length === 0) break
    if (used.has(t.iso)) continue
    const spec = nachtQ[0]; const span = spanOf(spec)
    const startMin = spec.cat === 'n40' ? nightStart(0, 4 * 60, span, `s-${t.iso}`) : nightStart(20 * 60, 24 * 60, span, `s-${t.iso}`)
    if (place(t.iso, startMin, spec, span)) { nachtQ.shift(); used.add(t.iso) }
  }

  // 3c) Normale Tagschichten („Frühschicht" 06–10 Uhr Start) auf die übrigen
  //     freien Werktage – in Datumsreihenfolge.
  for (const t of werktage) {
    if (normQ.length === 0) break
    if (used.has(t.iso)) continue
    const spec = normQ[0]; const span = spanOf(spec)
    if (place(t.iso, dayStart(span, `s-${t.iso}`), spec, span)) { normQ.shift(); used.add(t.iso) }
  }

  shifts.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)

  // 4) Nicht untergebrachte Stunden als Warnung (Ziel wird dann knapp verfehlt).
  const fehltSun = round2(sunQ.reduce((s, x) => s + x.net, 0))
  const fehltWerk = round2([...nachtQ, ...normQ].reduce((s, x) => s + x.net, 0))
  if (fehltSun > 0) warnings.push(`Sonntag: nur ${n2(sunday - fehltSun)} von ${n2(sunday)} Std möglich (max. 8 Std/Tag – zu wenige Sonntage oder Ruhezeit im Monat).`)
  if (fehltWerk > 0) warnings.push(`${n2(fehltWerk)} Stunden konnten nicht platziert werden (max. 8 Std/Tag, zu wenige Werktage/Ruhezeit).`)

  return { shifts, warnings }
}

function n2(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
