import assert from 'node:assert/strict'
import test from 'node:test'
import { planDriver, type Trip } from './uberPlan'
import { planAnZiel, skaliere } from './uberZielPlan'

function at(iso: string, hm: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const [hh, mm] = hm.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh, mm, 0)
}
const trip = (sd: string, s: string, ed: string, e: string): Trip => ({ startMs: at(sd, s), endMs: at(ed, e) })

function netSumme(plan: ReturnType<typeof planDriver>): number {
  return plan.days.filter((d) => d.kind === 'schicht').reduce((a, d) => a + d.shifts.reduce((x, s) => x + s.nettoH, 0), 0)
}
function sonntagNetto(plan: ReturnType<typeof planDriver>): number {
  return plan.days
    .filter((d) => d.kind === 'schicht' && new Date(d.date + 'T00:00:00Z').getUTCDay() === 0)
    .reduce((a, d) => a + d.shifts.reduce((x, s) => x + s.nettoH, 0), 0)
}

test('skaliere trifft die Zielsumme exakt und hält die Obergrenze', () => {
  const { vals, fehlt } = skaliere([600, 300, 120], 900) // 15 h Ziel
  assert.equal(vals.reduce((a, b) => a + b, 0), 900)
  assert.equal(fehlt, 0)
  assert.ok(vals.every((v) => v >= 0 && v <= 8 * 60))
})

test('skaliere meldet, was nicht aufs Budget passt (max 8 h/Tag)', () => {
  const { vals, fehlt } = skaliere([480, 480], 1200) // 20 h auf 2 Tage → max 16 h
  assert.equal(vals.reduce((a, b) => a + b, 0), 960)
  assert.equal(fehlt, 240)
})

test('planAnZiel: Monat trifft Gesamt und Sonntag exakt, echte Tage bleiben', () => {
  // Fünf Werktage + zwei Sonntage im Januar 2026 (So = 04. und 11.).
  const trips: Trip[] = [
    trip('2026-01-02', '08:00', '2026-01-02', '16:00'),
    trip('2026-01-03', '09:00', '2026-01-03', '15:00'),
    trip('2026-01-04', '10:00', '2026-01-04', '20:00'), // Sonntag
    trip('2026-01-05', '07:00', '2026-01-05', '17:00'),
    trip('2026-01-06', '08:00', '2026-01-06', '13:00'),
    trip('2026-01-09', '08:00', '2026-01-09', '16:00'),
    trip('2026-01-11', '11:00', '2026-01-11', '19:00'), // Sonntag
  ]
  const roh = planDriver('Nori', trips)
  const ziel = planAnZiel(roh, { gesamt: 30, sonntag: 10 })

  assert.equal(Math.round(netSumme(ziel) * 100) / 100, 30)
  assert.equal(Math.round(sonntagNetto(ziel) * 100) / 100, 10)
  // Nur echte Arbeitstage, keine erfundenen.
  const arbeit = ziel.days.filter((d) => d.kind === 'schicht')
  assert.ok(arbeit.every((d) => trips.some((t) => new Date(t.startMs).toISOString().slice(0, 10) === d.date)))
  // Kein Tag über 8 h netto.
  assert.ok(arbeit.every((d) => d.shifts[0].nettoH <= 8 + 1e-9))
})

test('planAnZiel: Sonntag größer als möglich → Gesamt bleibt exakt, Rest auf Werktage', () => {
  // Nur 2 Sonntage gefahren (04., 11.) → max 16 h Sonntag; Ziel Sonntag 24 h.
  const trips: Trip[] = [
    trip('2026-01-04', '08:00', '2026-01-04', '18:00'), // So
    trip('2026-01-11', '08:00', '2026-01-11', '18:00'), // So
    trip('2026-01-05', '08:00', '2026-01-05', '18:00'),
    trip('2026-01-06', '08:00', '2026-01-06', '18:00'),
    trip('2026-01-07', '08:00', '2026-01-07', '18:00'),
    trip('2026-01-08', '08:00', '2026-01-08', '18:00'),
    trip('2026-01-09', '08:00', '2026-01-09', '18:00'),
  ]
  const ziel = planAnZiel(planDriver('Y', trips), { gesamt: 40, sonntag: 24 })
  // Gesamt EXAKT getroffen, Sonntag bei max 16 gedeckelt, Warnung vorhanden.
  assert.equal(Math.round(netSumme(ziel) * 100) / 100, 40)
  assert.ok(sonntagNetto(ziel) <= 16 + 1e-9)
  assert.ok(ziel.weekNotes.some((w) => /Sonntag/.test(w)))
})

test('planAnZiel: kleiner Monat verteilt dünn, ohne die Summe zu sprengen', () => {
  const trips: Trip[] = [
    trip('2026-01-05', '08:00', '2026-01-05', '18:00'),
    trip('2026-01-06', '08:00', '2026-01-06', '18:00'),
    trip('2026-01-07', '08:00', '2026-01-07', '18:00'),
  ]
  const ziel = planAnZiel(planDriver('X', trips), { gesamt: 6, sonntag: 0 })
  assert.equal(Math.round(netSumme(ziel) * 100) / 100, 6)
})
