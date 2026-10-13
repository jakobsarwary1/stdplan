// Präzise, deterministische Schichtverteilung – trifft die eingegebenen Ziele
// EXAKT (per Konstruktion), statt sie wie der heuristische Verteiler
// (hoursMode.ts) nur bestmöglich anzunähern.
//
// Idee: Jede Kategorie bekommt EIGENE Schichten in ihrem Zeitbereich:
//   • Sonntagsstunden  -> Tagschichten AN SONNTAGEN (06–20 Uhr, nie im Nachtfenster)
//   • Nacht (REALISMUS) -> echte Spät-/Nachtschicht Mo–Fr, Start abends 20–22 Uhr,
//       über Mitternacht bis max. 06:00 – NIE 00:00-Start. Die ganze Arbeitszeit
//       liegt im Zuschlag (20–24 = 25 %, 00–04 = 40 %, 04–06 = 25 %); die
//       NACHT-SUMME (n25+n40) wird exakt getroffen, die 25/40-Aufteilung ergibt
//       sich aus der echten Uhrzeit (Modus „Realismus", von Jakob gewählt).
//   • Rest (normale Std)  -> Tagschichten (06–20 Uhr) an Werktagen, kein Zuschlag
// Gesamtsumme (bezahlt) und Sonntag treffen die Eingabe exakt; die bezahlte
// Summe wird über die Schicht-Spannen minutengenau auf den Zielwert gebracht.
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
// REALISTISCHE Nacht-/Spätschicht: beginnt am ABEND (20:00–22:00), läuft über
// Mitternacht bis max. 06:00 Folgetag – NIE um 00:00. Die ganze gearbeitete
// Zeit liegt in den Zuschlagsfenstern (20–24 = 25 %, 00–04 = 40 %, 04–06 = 25 %),
// die 25/40-Aufteilung ergibt sich also aus der echten Uhrzeit (Realismus-Modus,
// von Jakob gewählt). Die NACHT-SUMME bleibt exakt (= Σ Nacht-Netto).
const NIGHT_WIN_START = 20 * 60 // 20:00 – Beginn 25-%-Fenster
const NIGHT_WIN_END = 30 * 60   // 06:00 Folgetag – Ende der Nachtarbeit (Minuten ab Tagesbeginn)
const NIGHT_START_LATEST = 22 * 60 // spätestens 22:00 beginnen – nie Mitternacht

/** Startzeit einer realistischen Nacht-/Spätschicht (Abend), Spanne `span`. */
function nachtStart(span: number, seed: string): number {
  const latest = Math.min(NIGHT_START_LATEST, NIGHT_WIN_END - span)
  if (latest <= NIGHT_WIN_START) return NIGHT_WIN_START
  const steps: number[] = []
  for (let s = NIGHT_WIN_START; s <= latest; s += 15) steps.push(s)
  return pick(steps, seed)
}
/** Realistische Pause einer Nachtschicht (30–90 Min bei > 6 h, sonst keine). */
function nachtBreak(net: number, seed: string): number {
  if (net * 60 <= 6 * 60) return 0
  return pick([30, 45, 60, 75, 90], seed)
}

type Spec = { cat: 'sun' | 'nacht' | 'norm'; net: number; brk: number }

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

  // 1) Zuschlag-Schichten als Spezifikationen bauen (Netto = Ziel).
  //    Höchstens 8 Netto-Std/Tag – auch an Sonntagen und in der Nacht.
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
  // Nacht = EINE realistische Spät-/Nachtschicht je Block (bis 8 Netto-Std, mit
  // Pause), die abends beginnt und über Mitternacht läuft. Nacht-SUMME (= n25 +
  // n40) wird exakt getroffen; die Aufteilung 25 %/40 % ergibt sich aus der
  // tatsächlichen Uhrzeit (Realismus-Modus – von Jakob gewählt).
  const nachtGesamt = round2(n25 + n40)
  const nachtSpecs: Spec[] = []
  for (let rem = nachtGesamt; rem > 0.0001;) {
    const net = Math.min(rem, MAX_NET)
    nachtSpecs.push({ cat: 'nacht', net, brk: nachtBreak(net, `nb-${nachtSpecs.length}-${net}`) })
    rem = round2(rem - net)
  }

  // 2) Normale Schichten füllen die restliche bezahlte Zeit auf. Wir legen
  //    zuerst die SPANNEN fest (volle 8,5-h-Blöcke + ein Rest), damit die
  //    bezahlte Summe exakt stimmt; erst danach wird jede Spanne realistisch in
  //    Netto + Pause aufgeteilt (splitSpan) – das ändert die Spanne nicht.
  const spanOf = (s: Spec) => Math.round(s.net * 60) + s.brk
  const fixSpan = [...sunSpecs, ...nachtSpecs].reduce((a, s) => a + spanOf(s), 0)
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

  // 3) Spezifikationen auf Tage verteilen – WOCHENWEISE AUSGEGLICHEN (nicht mehr
  //    die ersten Tage des Monats vollstopfen). Regeln dabei:
  //      • Wochentags-Priorität (zuerst belegen): So, Fr, Sa, Di, Do, Mi, Mo.
  //        → freie Tage fallen dadurch bevorzugt auf Mo/Mi/Do.
  //      • Max. 30 bezahlte Std pro Woche (Mo–So).
  //      • Mind. 1 freier Tag pro Woche; nie 7 Tage am Stück.
  //      • Ruhezeit ≥ 11 h BEIDSEITIG; eine Schicht pro Tag.
  //    Sonntag hat Vorrang (zuerst + exakt), danach Nacht (bevorzugt Fr/Sa),
  //    dann die normalen Tagschichten – jeweils in die Woche mit den bisher
  //    wenigsten Stunden (gleichmäßige Verteilung über den ganzen Monat).
  const dayMs = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const shiftIso = (iso: string, delta: number) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10) }
  const mondayKey = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); const off = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; return shiftIso(iso, -off) }
  const REST = MIN_REST_MIN * 60000
  const WEEK_CAP_MIN = 30 * 60 // max. 30 bezahlte Std/Woche
  // Wochentags-Priorität: kleiner = zuerst belegen (So, Fr, Sa, Di, Do, Mi, Mo).
  const rank = (dow: number) => (dow === 0 ? 0 : dow === 5 ? 1 : dow === 6 ? 2 : dow === 2 ? 3 : dow === 4 ? 4 : dow === 3 ? 5 : 6)

  const placed: { s: number; e: number }[] = []
  const workedDays = new Set<string>()
  const weekPaid = new Map<string, number>()   // bezahlte Minuten je Woche
  const weekWorked = new Map<string, number>()  // Arbeitstage je Woche
  const daysInWeek = new Map<string, number>()  // Monatstage je Woche (für „1 frei")
  for (const t of tage) { const k = mondayKey(t.iso); daysInWeek.set(k, (daysInWeek.get(k) ?? 0) + 1) }

  const restOK = (s: number, e: number) => !placed.some((p) => s < p.e + REST && p.s < e + REST)
  const consecutive = (iso: string) => {
    let n = 1
    for (let d = shiftIso(iso, -1); workedDays.has(d); d = shiftIso(d, -1)) n++
    for (let d = shiftIso(iso, 1); workedDays.has(d); d = shiftIso(d, 1)) n++
    return n
  }
  const shifts: ExactShift[] = []
  const commit = (iso: string, startMin: number, spec: Spec, span: number) => {
    const s = dayMs(iso) + startMin * 60000, e = dayMs(iso) + (startMin + span) * 60000
    shifts.push(makeShift(iso, startMin, spec.net, spec.brk))
    placed.push({ s, e }); workedDays.add(iso)
    const k = mondayKey(iso)
    weekPaid.set(k, (weekPaid.get(k) ?? 0) + span)
    weekWorked.set(k, (weekWorked.get(k) ?? 0) + 1)
  }
  // Prüft alle strukturellen/rechtlichen Regeln. `cap`/`minFree` werden nur für
  // zwingende Schichten (Sonntag) gelockert; Ruhezeit und 7-Tage-Block bleiben
  // IMMER hart.
  const canPlace = (iso: string, startMin: number, span: number, cap: boolean, minFree: boolean) => {
    if (workedDays.has(iso)) return false
    const s = dayMs(iso) + startMin * 60000, e = dayMs(iso) + (startMin + span) * 60000
    if (!restOK(s, e)) return false
    if (consecutive(iso) >= 7) return false // nie 7 Tage am Stück
    const k = mondayKey(iso)
    if (cap && (weekPaid.get(k) ?? 0) + span > WEEK_CAP_MIN) return false // max. 30 Std/Woche
    if (minFree && (weekWorked.get(k) ?? 0) >= (daysInWeek.get(k) ?? 7) - 1) return false // mind. 1 frei
    return true
  }
  const startFor = (spec: Spec, span: number, iso: string) =>
    spec.cat === 'nacht' ? nachtStart(span, `s-${iso}`) : dayStart(span, `s-${iso}`)

  // 3a) Sonntage zuerst (Vorrang + exakt). Woche-Cap und „1 frei" hier gelockert
  //     – der Sonntag MUSS gesetzt werden; Ruhezeit und 7-Tage-Block bleiben hart.
  const sunQ: Spec[] = [...sunSpecs]
  for (const t of tage) {
    if (t.dow !== 0 || sunQ.length === 0) continue
    const spec = sunQ[0], span = spanOf(spec), start = startFor(spec, span, t.iso)
    if (canPlace(t.iso, start, span, false, false)) { commit(t.iso, start, spec, span); sunQ.shift() }
  }

  // Generischer, wochenausgeglichener Platzierer. `nightPref`: Nacht bevorzugt
  // Freitag (erst Wochentag, dann Wochenausgleich); normal umgekehrt (erst
  // gleichmäßig über die Wochen, dann Wochentag → freie Tage = Mo/Mi/Do).
  let capWarned = false
  const verteile = (q: Spec[], nightPref: boolean, days: { iso: string; dow: number }[]) => {
    while (q.length) {
      const spec = q[0], span = spanOf(spec)
      let cands = days.filter((t) => canPlace(t.iso, startFor(spec, span, t.iso), span, true, true))
      let relaxedCap = false
      if (!cands.length) { cands = days.filter((t) => canPlace(t.iso, startFor(spec, span, t.iso), span, false, true)); relaxedCap = true }
      if (!cands.length) break // passt unter den Regeln nirgends mehr → Rest als Warnung
      cands.sort((a, b) => {
        const wa = weekPaid.get(mondayKey(a.iso)) ?? 0, wb = weekPaid.get(mondayKey(b.iso)) ?? 0
        return nightPref
          ? rank(a.dow) - rank(b.dow) || wa - wb || a.iso.localeCompare(b.iso)
          : wa - wb || rank(a.dow) - rank(b.dow) || a.iso.localeCompare(b.iso)
      })
      const t = cands[0]
      commit(t.iso, startFor(spec, span, t.iso), spec, span)
      if (relaxedCap && !capWarned) { warnings.push('Hinweis: Mit diesen Stunden lassen sich nicht alle Wochen unter 30 bezahlten Std halten – einzelne Wochen liegen darüber.'); capWarned = true }
      q.shift()
    }
  }

  // 3b) Nacht zuerst – NUR Mo–Fr (eine Nachtschicht quert in den Folgetag; an
  //     Samstag würde sie in den Sonntag laufen und dort fälschlich als
  //     Sonntag+Nacht zählen → Sonntagssumme kaputt). Freitag wird bevorzugt
  //     (Fr-Abend → Sa-Nacht = Wochenendabdeckung). 3c) normale Tagschichten Mo–Sa.
  const nachtQ: Spec[] = [...nachtSpecs]
  const normQ: Spec[] = [...normSpecs]
  verteile(nachtQ, true, tage.filter((t) => t.dow >= 1 && t.dow <= 5))
  verteile(normQ, false, tage.filter((t) => t.dow !== 0))

  shifts.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)

  // 4) Nicht untergebrachte Stunden als Warnung (Ziel wird dann knapp verfehlt).
  const fehltSun = round2(sunQ.reduce((s, x) => s + x.net, 0))
  const fehltWerk = round2([...nachtQ, ...normQ].reduce((s, x) => s + x.net, 0))
  if (fehltSun > 0) warnings.push(`Sonntag: nur ${n2(sunday - fehltSun)} von ${n2(sunday)} Std möglich (max. 8 Std/Tag – zu wenige Sonntage oder Ruhezeit im Monat).`)
  if (fehltWerk > 0) warnings.push(`${n2(fehltWerk)} Std konnten nicht platziert werden (Grenzen: max. 8 Std/Tag & 30 Std/Woche, mind. 1 freier Tag/Woche, keine 7-Tage-Blöcke, Ruhezeit ≥ 11 h). Ggf. Gesamtstunden senken oder auf mehr Fahrer verteilen.`)

  return { shifts, warnings }
}

function n2(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
