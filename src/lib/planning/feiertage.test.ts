import assert from 'node:assert/strict'
import test from 'node:test'
import { gesetzlicheFeiertage, feiertageImMonat } from './feiertage'

test('Ostern 2026 korrekt (Ostersonntag 05.04.) – bewegliche Feiertage', () => {
  const f = gesetzlicheFeiertage(2026, 'NW')
  assert.ok(f.has('2026-04-03'), 'Karfreitag 03.04.2026')
  assert.ok(f.has('2026-04-06'), 'Ostermontag 06.04.2026')
  assert.ok(f.has('2026-05-14'), 'Christi Himmelfahrt 14.05.2026')
  assert.ok(f.has('2026-05-25'), 'Pfingstmontag 25.05.2026')
  assert.ok(f.has('2026-06-04'), 'Fronleichnam 04.06.2026 (NW)')
})

test('bundesweite Feiertage immer dabei', () => {
  const f = gesetzlicheFeiertage(2026, 'HH')
  for (const d of ['2026-01-01', '2026-05-01', '2026-10-03', '2026-12-25', '2026-12-26']) {
    assert.ok(f.has(d), d)
  }
})

test('länderspezifisch: Fronleichnam & Allerheiligen nur in bestimmten Ländern', () => {
  assert.ok(gesetzlicheFeiertage(2026, 'NW').has('2026-11-01'), 'Allerheiligen in NW')
  assert.ok(!gesetzlicheFeiertage(2026, 'HH').has('2026-11-01'), 'kein Allerheiligen in HH')
  assert.ok(!gesetzlicheFeiertage(2026, 'HH').has('2026-06-04'), 'kein Fronleichnam in HH')
  assert.ok(gesetzlicheFeiertage(2026, 'SN').has('2026-10-31'), 'Reformationstag in SN')
})

test('Buß- und Bettag 2026 = Mittwoch 18.11. (nur Sachsen)', () => {
  assert.ok(gesetzlicheFeiertage(2026, 'SN').has('2026-11-18'))
  assert.ok(!gesetzlicheFeiertage(2026, 'NW').has('2026-11-18'))
})

test('feiertageImMonat filtert auf den Monat', () => {
  assert.deepEqual(feiertageImMonat('2026-05', 'NW'), ['2026-05-01', '2026-05-14', '2026-05-25'])
  assert.deepEqual(feiertageImMonat('2026-08', 'NW'), []) // August hat in NW keinen Feiertag
  assert.deepEqual(feiertageImMonat('2026-08', 'SL'), ['2026-08-15']) // Mariä Himmelfahrt im Saarland
})
