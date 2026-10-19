import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlansFromFahrlygoCsv, looksLikeFahrlygo, parseFahrlygoDatum } from './fahrlygoPlan'

test('parseFahrlygoDatum liest DD.MM.YYYY HH:MM als Wanduhr', () => {
  assert.equal(parseFahrlygoDatum('31.01.2026 03:49'), Date.UTC(2026, 0, 31, 3, 49, 0))
  assert.equal(parseFahrlygoDatum('05.06.2026 14:00:30'), Date.UTC(2026, 5, 5, 14, 0, 30))
  assert.equal(parseFahrlygoDatum('quatsch'), null)
})

test('looksLikeFahrlygo erkennt den CSV-Kopf (Semikolon, Datum, Fahrer)', () => {
  assert.equal(looksLikeFahrlygo('﻿Datum;Fahrer;Kunde;Preis (EUR)\n01.01.2026 10:00;Max'), true)
  assert.equal(looksLikeFahrlygo('Trip ID,Vorname des Fahrers,Zeitpunkt der Fahrtbestellung\n'), false)
})

test('buildPlansFromFahrlygoCsv gruppiert je Fahrer und überspringt Stornos', () => {
  const csv = [
    'Datum;Fahrer;Kunde;Abholadresse;Zieladresse;Status;Zahlung;Preis (EUR);Rate (EUR/km)',
    '05.01.2026 09:10;Max Muster;A;"Straße 1, Köln";"Weg 2, Köln";;;6,00;',
    '05.01.2026 12:30;Max Muster;B;"Straße 1, Köln";"Weg 2, Köln";;;8,00;',
    '05.01.2026 03:00;Lena Fahrer;C;"Straße 1, Köln";"Weg 2, Köln";storniert;;;0,00;',
  ].join('\n')
  const plans = buildPlansFromFahrlygoCsv([csv])
  assert.equal(plans.length, 1) // Lenas einzige Fahrt ist storniert → kein Plan
  assert.equal(plans[0].name, 'Max Muster')
  const tag = plans[0].days.find((d) => d.date === '2026-01-05')
  assert.ok(tag && tag.kind === 'schicht', 'Max hat am 05.01. eine Schicht')
})

test('große Lücke am selben Tag ergibt ZWEI Schichten (nichts verworfen)', () => {
  const csv = [
    'Datum;Fahrer;Kunde;Abholadresse;Zieladresse;Status;Zahlung;Preis (EUR);Rate (EUR/km)',
    '12.01.2026 06:30;A B;k;"x";"y";;;5,00;', // Frühschicht
    '12.01.2026 08:40;A B;k;"x";"y";;;5,00;',
    '12.01.2026 17:00;A B;k;"x";"y";;;5,00;', // Spätschicht (Lücke ~8 h)
    '12.01.2026 20:10;A B;k;"x";"y";;;5,00;',
  ].join('\n')
  const p = buildPlansFromFahrlygoCsv([csv])[0]
  const tag = p.days.find((d) => d.date === '2026-01-12')
  assert.ok(tag, 'Tag vorhanden')
  assert.equal(tag!.shifts.length, 2, 'zwei Schichten am selben Tag')
  assert.equal(tag!.hinweis, '', 'keine Fahrt als „nicht im Plan" verworfen')
})
