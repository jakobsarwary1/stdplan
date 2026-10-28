import assert from 'node:assert/strict'
import test from 'node:test'
import { readTripsFromCsv, normName, findeDoppelVerdacht, findeDoppelPaare, applyMerges, type Trip } from './uberPlan'

const KOPF = 'Vorname des Fahrers,Nachname des Fahrers,UUID des Fahrers,Zeitpunkt der Fahrtbestellung,Ankunftszeit der Fahrt,Fahrtstatus'
const zeile = (vor: string, nach: string, id: string, a: string, b: string) =>
  `${vor},${nach},${id},2026-01-05 ${a}:00:00,2026-01-05 ${b}:00:00,completed`

test('normName: nur Formatierung weg, keine Fuzzy-Angleichung', () => {
  assert.equal(normName('  Syuleyman  Sali   Nasuf '), 'syuleyman sali nasuf')
  assert.notEqual(normName('Syuleyman Sali Nasuf'), normName('SyuleymanDUP NasufDUP'))
})

test('Merge nach Fahrer-ID: gleiche ID (andere Schreibweise) → EIN Fahrer', () => {
  const csv = [KOPF, zeile('Ali', 'Nasuf', 'ID1', '08', '12'), zeile('Ali', 'Nassuf', 'ID1', '14', '18')].join('\n')
  const m = readTripsFromCsv([csv])
  assert.equal(m.size, 1)
  assert.equal([...m.values()][0].length, 2)
})

test('Gleicher Name, VERSCHIEDENE ID → bleiben getrennt (zwei Fahrer)', () => {
  const csv = [KOPF, zeile('Ali', 'Nasuf', 'ID1', '08', '12'), zeile('Ali', 'Nasuf', 'ID2', '14', '18')].join('\n')
  const m = readTripsFromCsv([csv])
  assert.equal(m.size, 2)
  assert.deepEqual([...m.keys()].sort(), ['Ali Nasuf', 'Ali Nasuf (2)'])
})

test('Ohne ID-Spalte: nur exakt gleicher Name merged', () => {
  const kopf = 'Vorname des Fahrers,Nachname des Fahrers,Zeitpunkt der Fahrtbestellung,Ankunftszeit der Fahrt,Fahrtstatus'
  const z = (v: string, n: string, a: string, b: string) => `${v},${n},2026-01-05 ${a}:00:00,2026-01-05 ${b}:00:00,completed`
  const csv = [kopf, z('Ali', 'Nasuf', '08', '12'), z('ALI', 'nasuf', '14', '18'), z('Omar', 'Khan', '09', '13')].join('\n')
  const m = readTripsFromCsv([csv])
  assert.equal(m.size, 2) // Ali (2x, exakt gleich normiert) + Omar
})

test('findeDoppelVerdacht: DUP-Fall wird gemeldet, echte verschiedene Fahrer nicht', () => {
  const w = findeDoppelVerdacht(['Syuleyman Sali Nasuf', 'SyuleymanDUP NasufDUP', 'Ahmad Nabi Azzad', 'Mohammad Musa Azzad'])
  assert.equal(w.length, 1)
  assert.match(w[0], /Syuleyman/)
})

test('findeDoppelPaare + applyMerges: bestätigte Zusammenführung legt Fahrten zusammen', () => {
  const paare = findeDoppelPaare(['Syuleyman Sali Nasuf', 'SyuleymanDUP NasufDUP'])
  assert.equal(paare.length, 1)
  const t = (h: number): Trip => ({ startMs: h * 3600000, endMs: (h + 2) * 3600000 })
  const drivers = new Map<string, Trip[]>([
    ['Syuleyman Sali Nasuf', [t(8)]],
    ['SyuleymanDUP NasufDUP', [t(14), t(18)]],
  ])
  const merged = applyMerges(drivers, paare)
  assert.equal(merged.size, 1)
  assert.equal([...merged.values()][0].length, 3) // 1 + 2 Fahrten
})
