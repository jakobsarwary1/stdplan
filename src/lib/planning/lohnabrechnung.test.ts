import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLohnabrechnung, findeFahrer, nameKey } from './lohnabrechnung'

// Synthetische Zeilen im Layout, das pdfLayoutLines liefert (keine echten Daten).
const VOLL = [
  'Abrechnung der Brutto-Netto-Bezüge August 2026',
  'persönlich / vertraulich', '', 'Herrn', '', 'Beispiel Anton', '', 'Musterweg 6',
  'Lohnart Bezeichnung bezahlte Menge Faktor %-Zuschlag St* SV* GB* Betrag',
  '1 Lohn 108,00 13,9000 L L J 1.501,20 EUR',
  '7 Lohnfortzahlung Krank 36,00 13,9000 100,00 L L J 500,40 EUR',
  '11 Nachtzuschlag (25%) steuerfrei 38,50 3,4750 25,00 F F J 133,79 EUR',
  '12 Nachtzuschlag (40%) steuerfrei 25,50 5,5600 40,00 F F J 141,78 EUR',
  '13 Sonntagszuschlag (50%) 8,00 6,9500 50,00 F F J 55,60 EUR',
  '15 Feiertagszuschlag (125%) 6,00 17,3750 125,00 F F J 104,25 EUR',
]
const ZWEI_BLOECKE = [ // Teilmonat: „Lohn" muss summiert werden
  'Abrechnung der Brutto-Netto-Bezüge August 2026', 'Herrn', '', 'Beispiel Bernd', 'Musterweg 1',
  '1 Lohn 43,00 13,9000 L L J 597,70 EUR',
  '11 Nachtzuschlag (25%) steuerfrei 0,25 3,4750 25,00 F F J 0,87 EUR',
  'Herrn', '', 'Beispiel Bernd',
  '1 Lohn 15,00 13,9000 L L J 208,50 EUR',
]
const MINIJOB_MENGE = [
  'Abrechnung der Brutto-Netto-Bezüge August 2026', 'Herrn', '', 'Beispiel Carla', 'Musterstr. 2',
  '1 Lohn 5,00 13,9000 L L J 69,50 EUR',
]
const MINIJOB_NUR_EUR = [ // ohne gedruckte Menge → aus Betrag ableiten
  'Abrechnung der Brutto-Netto-Bezüge August 2026', 'Frau', '', 'Beispiel Dora', 'Musterstr. 3',
  '1 Lohn 139,00 EUR',
]

test('parseLohnabrechnung: alle Zuschläge + Krank + Feiertag exakt, Name/Monat erkannt', () => {
  const r = parseLohnabrechnung(VOLL)
  assert.equal(r.name, 'Beispiel Anton')
  assert.equal(r.month, '2026-08')
  assert.equal(r.gesamt, 108)
  assert.equal(r.sonntag, 8)
  assert.equal(r.nacht25, 38.5)
  assert.equal(r.nacht40, 25.5)
  assert.equal(r.feiertag, 6)
  assert.equal(r.krank, 36)
})

test('parseLohnabrechnung: zwei „Lohn"-Blöcke summiert (43 + 15 = 58)', () => {
  const r = parseLohnabrechnung(ZWEI_BLOECKE)
  assert.equal(r.gesamt, 58)
  assert.equal(r.nacht25, 0.25)
})

test('parseLohnabrechnung: Minijob mit gedruckter Menge', () => {
  assert.equal(parseLohnabrechnung(MINIJOB_MENGE).gesamt, 5)
})

test('parseLohnabrechnung: Minijob ohne Menge → aus Betrag ÷ Stundenlohn (139 ÷ 13,90 = 10)', () => {
  const r = parseLohnabrechnung(MINIJOB_NUR_EUR)
  assert.equal(r.gesamt, 10)
  assert.ok(r.warnungen.length >= 1)
})

test('nameKey: reihenfolge-unabhängig, Format/Komma weg', () => {
  assert.equal(nameKey('Beispiel Anton'), nameKey('Anton Beispiel'))
  assert.equal(nameKey('Beispiel, Eva Maria'), nameKey('Eva Maria Beispiel'))
})

test('findeFahrer: ordnet reihenfolge-unabhängig zu, hält gleiche Nachnamen getrennt', () => {
  const fahrer = ['Anton Beispiel', 'Said Muster', 'Sara Muster']
  assert.equal(findeFahrer('Beispiel Anton', fahrer), 'Anton Beispiel')
  assert.equal(findeFahrer('Said Muster', fahrer), 'Said Muster')
  assert.equal(findeFahrer('Sara Muster', fahrer), 'Sara Muster')
  assert.equal(findeFahrer('Niemand Hier', fahrer), null)
})
