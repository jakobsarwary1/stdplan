import assert from 'node:assert/strict'
import test from 'node:test'
import { planDriver, type Trip } from './uberPlan'
import { planAnZiel, skaliere } from './uberZielPlan'
import { computeShiftHours } from './wage'

function at(iso: string, hm: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const [hh, mm] = hm.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh, mm, 0)
}
const trip = (sd: string, s: string, ed: string, e: string): Trip => ({ startMs: at(sd, s), endMs: at(ed, e) })

type P = ReturnType<typeof planDriver>
function netSumme(plan: P): number {
  return plan.days.filter((d) => d.kind === 'schicht').reduce((a, d) => a + d.shifts.reduce((x, s) => x + s.nettoH, 0), 0)
}
/** Tatsächliche Sonntagsstunden (ab 00:00, mitternachtsgenau, ohne Pause). */
function sonntagIst(plan: P): number {
  let so = 0
  for (const d of plan.days) {
    if (d.kind !== 'schicht') continue
    for (const s of d.shifts) {
      so += computeShiftHours({ date: s.date, startMin: s.startMin, endMin: s.endMin, breaks: s.pauseAt }).sunday50
    }
  }
  return Math.round(so * 100) / 100
}

test('skaliere trifft die Zielsumme exakt und hält die Obergrenze', () => {
  const { vals, fehlt } = skaliere([600, 300, 120], 900)
  assert.equal(vals.reduce((a, b) => a + b, 0), 900)
  assert.equal(fehlt, 0)
  assert.ok(vals.every((v) => v >= 0 && v <= 8 * 60))
})

test('planAnZiel: Gesamt exakt, Sonntag (tatsächlich) nah am Ziel', () => {
  const trips: Trip[] = [
    trip('2026-01-02', '08:00', '2026-01-02', '16:00'),
    trip('2026-01-04', '10:00', '2026-01-04', '18:00'), // So
    trip('2026-01-05', '07:00', '2026-01-05', '17:00'),
    trip('2026-01-06', '08:00', '2026-01-06', '13:00'),
    trip('2026-01-09', '08:00', '2026-01-09', '16:00'),
    trip('2026-01-11', '11:00', '2026-01-11', '19:00'), // So
  ]
  const ziel = planAnZiel(planDriver('Nori', trips), { gesamt: 30, sonntag: 10 })
  assert.ok(Math.abs(netSumme(ziel) - 30) <= 0.02, `Gesamt ${netSumme(ziel)}`)
  assert.ok(Math.abs(sonntagIst(ziel) - 10) <= 0.5, `Sonntag ist ${sonntagIst(ziel)}`)
})

test('planAnZiel: Samstagnacht zählt als Sonntag (ab 00:00)', () => {
  // Fahrt Samstag 20:00 → Sonntag 04:00: die Stunden nach Mitternacht sind Sonntag.
  const trips: Trip[] = [
    trip('2026-01-03', '20:00', '2026-01-04', '04:00'), // Sa-Nacht → So
    trip('2026-01-05', '08:00', '2026-01-05', '18:00'),
    trip('2026-01-06', '08:00', '2026-01-06', '18:00'),
  ]
  const ziel = planAnZiel(planDriver('X', trips), { gesamt: 20, sonntag: 3 })
  assert.ok(Math.abs(netSumme(ziel) - 20) <= 0.02, `Gesamt ${netSumme(ziel)}`)
  assert.ok(sonntagIst(ziel) >= 2.5, `Sonntag aus Samstagnacht: ${sonntagIst(ziel)}`)
})

test('planAnZiel: zu wenige echte Sonntage → Zusatz-Sonntage werden angesetzt', () => {
  // Nur 1 echter Sonntag gefahren, Ziel 20 h Sonntag → System setzt weitere
  // Kalender-Sonntage an (Januar 2026 hat 4). Gesamt bleibt exakt.
  const trips: Trip[] = [
    trip('2026-01-04', '09:00', '2026-01-04', '18:00'), // So
    trip('2026-01-05', '08:00', '2026-01-05', '18:00'),
    trip('2026-01-06', '08:00', '2026-01-06', '18:00'),
    trip('2026-01-07', '08:00', '2026-01-07', '18:00'),
    trip('2026-01-08', '08:00', '2026-01-08', '18:00'),
  ]
  const roh = planDriver('Y', trips)
  const soVorher = roh.days.filter((d) => d.kind === 'schicht' && new Date(d.date + 'T00:00:00Z').getUTCDay() === 0).length
  const ziel = planAnZiel(roh, { gesamt: 40, sonntag: 20 })
  assert.ok(Math.abs(netSumme(ziel) - 40) <= 0.02, `Gesamt ${netSumme(ziel)}`)
  assert.ok(Math.abs(sonntagIst(ziel) - 20) <= 0.5, `Sonntag ist ${sonntagIst(ziel)}`)
  const soNachher = ziel.days.filter((d) => d.kind === 'schicht' && new Date(d.date + 'T00:00:00Z').getUTCDay() === 0).length
  assert.ok(soNachher > soVorher, `Zusatz-Sonntage: vorher ${soVorher}, nachher ${soNachher}`)
  assert.ok(ziel.weekNotes.some((w) => /Sonntag/.test(w)))
})

test('planAnZiel: zwei gefahrene Tage → auf BEIDE dünn strecken, nicht 8 h auf einen', () => {
  const trips: Trip[] = [
    trip('2026-01-06', '16:45', '2026-01-06', '20:00'), // Werktag
    trip('2026-01-18', '12:15', '2026-01-18', '15:00'), // Sonntag
  ]
  const ziel = planAnZiel(planDriver('Nori', trips), { gesamt: 10, sonntag: 0 })
  const arbeit = ziel.days.filter((d) => d.kind === 'schicht')
  assert.equal(arbeit.length, 2, 'beide Tage belegt')
  assert.ok(arbeit.every((d) => d.shifts[0].nettoH > 0 && d.shifts[0].nettoH < 8), 'kein Tag voll auf 8 h')
  assert.ok(Math.abs(netSumme(ziel) - 10) <= 0.02, `Gesamt ${netSumme(ziel)}`)
})

test('planAnZiel: höchstens 6 Arbeitstage am Stück (§ 11 ArbZG)', () => {
  // 8 Tage in Folge gefahren.
  const trips: Trip[] = ['05', '06', '07', '08', '09', '10', '11', '12']
    .map((d) => trip(`2026-01-${d}`, '08:00', `2026-01-${d}`, '14:00'))
  const ziel = planAnZiel(planDriver('W', trips), { gesamt: 36, sonntag: 0 })
  const belegt = ziel.days.map((d) => d.kind === 'schicht' && d.shifts.reduce((a, s) => a + s.nettoH, 0) > 0)
  let run = 0; let maxRun = 0
  for (const b of belegt) { run = b ? run + 1 : 0; maxRun = Math.max(maxRun, run) }
  assert.ok(maxRun <= 6, `längster Block ${maxRun} Tage`)
})

test('planAnZiel: kleiner Monat verteilt dünn, ohne die Summe zu sprengen', () => {
  const trips: Trip[] = [
    trip('2026-01-05', '08:00', '2026-01-05', '18:00'),
    trip('2026-01-06', '08:00', '2026-01-06', '18:00'),
    trip('2026-01-07', '08:00', '2026-01-07', '18:00'),
  ]
  const ziel = planAnZiel(planDriver('Z', trips), { gesamt: 6, sonntag: 0 })
  assert.equal(Math.round(netSumme(ziel) * 100) / 100, 6)
})
