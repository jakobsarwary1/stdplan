// Präzise, deterministische Schichtverteilung – trifft die eingegebenen Ziele
// EXAKT (per Konstruktion), statt sie wie der heuristische Verteiler
// (hoursMode.ts) nur bestmöglich anzunähern.
//
// Idee: Jede Zuschlagsart bekommt EIGENE Schichten, die ausschließlich in ihr
// Zeitfenster/ihren Tag fallen – ohne Überschneidung:
//   • Sonntagsstunden  -> Tagschichten AN SONNTAGEN (08:00, nie in Nachtfenster)
//   • Nacht 40 % (00–04) -> Schichten 00:00–00:00+net (net ≤ 4) an Werktagen
//   • Nacht 25 % (20–24) -> Schichten 20:00–20:00+net (net ≤ 4) an Werktagen
//   • Rest (normale Std)  -> Tagschichten (08:00) an Werktagen, kein Zuschlag
// Dadurch zählt jede gearbeitete Stunde genau einmal in die gewünschte Spalte;
// die Summen treffen die Eingabe exakt. Die bezahlte Gesamtsumme (Netto + Pause)
// wird über die letzte normale Schicht minutengenau auf den Zielwert gebracht.
//
// Kompromiss: Der Plan ist bewusst schematisch (feste Startzeiten, eine Schicht
// pro Tag) – dafür stimmen die Zahlen. Lassen sich nicht alle Stunden unterbringen
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
const MAX_SUN_NET = 11 // Tagschicht 08:00 + Pause endet ≤ 20:00 (kein Nachtfenster)
const NORMAL_NET = 8
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Gesetzliche Mindestpause (§ 4 ArbZG) nach Arbeitszeit. */
function breakFor(workMin: number): number {
  if (workMin > 9 * 60) return 45
  if (workMin > 6 * 60) return 30
  return 0
}

/** Schicht ab `startMin` mit `net` Netto-Stunden; Pause (falls nötig) in der Mitte. */
function makeShift(date: string, startMin: number, net: number): ExactShift {
  const workMin = Math.max(0, Math.round(net * 60))
  const br = breakFor(workMin)
  const half = Math.round(workMin / 2)
  const breaks = br > 0 ? [{ start: half, end: half + br }] : []
  return { date, startMin, endMin: startMin + workMin + br, breakMinutes: br, breaks, netHours: workMin / 60 }
}

/** Spanne (bezahlt, inkl. Pause) einer Schicht mit `net` Netto-Stunden, in Minuten. */
function spanMin(net: number): number {
  const w = Math.round(net * 60)
  return w + breakFor(w)
}

/** Netto-Stunden, deren bezahlte Spanne exakt `span` Minuten ergibt (für den Feinschliff). */
function netForSpan(span: number): number {
  if (span <= 6 * 60) return span / 60
  if (span <= 9 * 60 + 30) return (span - 30) / 60 // 30 min Pause
  return (span - 45) / 60 // 45 min Pause
}

type Tmpl = { startMin: number; net: number }

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

  // 1) Zuschlag-Schichten als Vorlagen bauen (Netto = Ziel, keine Überschneidung).
  const sundayTmpl: Tmpl[] = []
  for (let rem = sunday; rem > 0.0001;) { const net = Math.min(rem, MAX_SUN_NET); sundayTmpl.push({ startMin: 8 * 60, net }); rem = round2(rem - net) }
  const n40Tmpl: Tmpl[] = []
  for (let rem = n40; rem > 0.0001;) { const net = Math.min(rem, 4); n40Tmpl.push({ startMin: 0, net }); rem = round2(rem - net) }
  const n25Tmpl: Tmpl[] = []
  for (let rem = n25; rem > 0.0001;) { const net = Math.min(rem, 4); n25Tmpl.push({ startMin: 20 * 60, net }); rem = round2(rem - net) }

  // 2) Normale Tagschichten, bis die bezahlte Summe (grob) erreicht ist; die
  //    letzte Schicht bringt den Rest minutengenau auf den Zielwert.
  const fixSpan = [...sundayTmpl, ...n40Tmpl, ...n25Tmpl].reduce((s, t) => s + spanMin(t.net), 0)
  let restSpan = Math.round(bezahlt * 60) - fixSpan // noch zu verteilende bezahlte Minuten
  const normalTmpl: Tmpl[] = []
  if (restSpan < 0) {
    warnings.push('Die Zuschlagsstunden ergeben allein schon mehr bezahlte Zeit als die eingegebene Gesamtsumme – bitte Gesamt-Std erhöhen oder Zuschläge senken.')
  } else {
    const vollSpan = spanMin(NORMAL_NET)
    while (restSpan >= vollSpan + 60) { normalTmpl.push({ startMin: 8 * 60, net: NORMAL_NET }); restSpan -= vollSpan }
    if (restSpan > 0) {
      const net = netForSpan(restSpan)
      if (net >= 0.5) normalTmpl.push({ startMin: 8 * 60, net: round2(net) })
      else if (normalTmpl.length > 0) {
        // Mini-Rest auf die letzte normale Schicht aufschlagen (minutengenau).
        const last = normalTmpl[normalTmpl.length - 1]
        last.net = round2(netForSpan(spanMin(last.net) + restSpan))
      }
    }
  }

  // 3) Vorlagen auf Tage verteilen: Sonntage nur Sonntagsschichten, Werktage die
  //    übrigen; eine Schicht pro Tag; Ruhezeit ≥ 11 h, sonst Tag freilassen.
  const tage = monthDays(year, month1)
  const dayMs = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const weekdayQ: Tmpl[] = [...n40Tmpl, ...n25Tmpl, ...normalTmpl]
  const sunQ: Tmpl[] = [...sundayTmpl]
  const shifts: ExactShift[] = []
  let prevEnd: number | null = null

  for (const t of tage) {
    const istSon = t.dow === 0
    const q = istSon ? sunQ : weekdayQ
    if (q.length === 0) continue
    const tmpl = q[0]
    const startAbs = dayMs(t.iso) + tmpl.startMin * 60000
    const endAbs = dayMs(t.iso) + (tmpl.startMin + spanMin(tmpl.net)) * 60000
    if (prevEnd != null && startAbs - prevEnd < MIN_REST_MIN * 60000) continue // Ruhezeit zu kurz -> Tag frei
    shifts.push(makeShift(t.iso, tmpl.startMin, tmpl.net))
    prevEnd = endAbs
    q.shift()
  }

  // 4) Nicht untergebrachte Stunden als Warnung (Ziel wird dann knapp verfehlt).
  const fehltSun = round2(sunQ.reduce((s, t) => s + t.net, 0))
  const fehltWerk = round2(weekdayQ.reduce((s, t) => s + t.net, 0))
  if (fehltSun > 0) warnings.push(`${n2(fehltSun)} Sonntagsstunden konnten nicht platziert werden (zu wenige freie Sonntage/Ruhezeit).`)
  if (fehltWerk > 0) warnings.push(`${n2(fehltWerk)} Stunden konnten nicht platziert werden (zu wenige Werktage/Ruhezeit).`)

  return { shifts, warnings }
}

function n2(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
