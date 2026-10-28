import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlansFromCsv, dayRow, planDriver, timesheetLines, snapPause, statutoryPause, type Trip } from './uberPlan'

function at(iso: string, hm: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const [hh, mm] = hm.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh, mm, 0)
}

function trip(startDay: string, start: string, endDay: string, end: string): Trip {
  return { startMs: at(startDay, start), endMs: at(endDay, end) }
}

function worked(name: string, trips: Trip[]) {
  return planDriver(name, trips).days.filter((d) => d.kind === 'schicht')
}

test('Pause rastet auf die Viertelstunde ein', () => {
  assert.equal(snapPause(0.1), 0)
  assert.equal(snapPause(0.3), 0.25)
  assert.equal(snapPause(0.4), 0.5)
  assert.equal(snapPause(1.5), 1.5)
  assert.equal(snapPause(2), 1.5)
})

test('Pflichtpause folgt der Schichtspanne', () => {
  assert.equal(statutoryPause(5.5), 0)
  assert.equal(statutoryPause(6.2), 0)
  assert.equal(statutoryPause(6.6), 0.5)
  assert.equal(statutoryPause(10), 0.75)
})

test('Lücke über 1,50 h mit kurzer Rückkehr bleibt eine Schicht', () => {
  const days = worked('Ali', [
    trip('2026-09-08', '08:00', '2026-09-08', '12:00'),
    trip('2026-09-08', '14:00', '2026-09-08', '18:00'),
  ])
  assert.equal(days.length, 1)
  assert.equal(days[0].shifts.length, 1)
  assert.equal(days[0].shifts[0].pauseH, 1.5)
  assert.equal(days[0].shifts[0].paidH, 10)
  assert.match(days[0].shifts[0].hinweis, /1,50/)
})

test('Lücke ab 11 Stunden ist Feierabend', () => {
  const days = worked('Ali', [
    trip('2026-09-08', '08:00', '2026-09-08', '12:00'),
    trip('2026-09-08', '23:00', '2026-09-09', '02:00'),
  ])
  assert.equal(days.length, 1)
  assert.equal(days[0].shifts.length, 2)
  assert.equal(days[0].shifts[1].restH, 11)
  assert.equal(days[0].shifts[1].hinweis, '')
})

test('Nach 10 Stunden liegt der Rest in der Ruhezeit und wird keine zweite Schicht', () => {
  const plan = planDriver('Ali', [
    trip('2026-09-08', '08:00', '2026-09-08', '12:00'),
    trip('2026-09-08', '13:00', '2026-09-08', '19:00'),
  ])
  const day = plan.days.find((d) => d.date === '2026-09-08')
  assert.equal(day?.shifts.length, 1)
  assert.equal(day?.shifts[0].paidH, 4)
  assert.match(day?.ausgelassen ?? '', /13:00/)
})

test('Volle Woche verliert den leichtesten Tag als Ruhetag', () => {
  const trips: Trip[] = []
  for (let day = 7; day <= 13; day++) {
    const iso = `2026-09-${String(day).padStart(2, '0')}`
    const end = day === 9 ? '12:00' : '16:00'
    trips.push(trip(iso, '08:00', iso, end))
  }
  const plan = planDriver('Ali', trips)
  const ruhe = plan.days.find((d) => d.kind === 'ruhetag')
  assert.equal(ruhe?.date, '2026-09-09')
  assert.equal(plan.workDays, 6)
  assert.equal(plan.ruheTage, 1)
})

test('Zwei freie Tage bleiben, ein dritter wird nicht erfunden', () => {
  const trips: Trip[] = []
  for (const day of [7, 8, 9, 10, 11]) {
    const iso = `2026-09-${String(day).padStart(2, '0')}`
    trips.push(trip(iso, '08:00', iso, '16:00'))
  }
  const plan = planDriver('Ali', trips)
  assert.equal(plan.ruheTage, 0)
  assert.equal(plan.workDays, 5)
})

test('Kurze Randwoche wird nicht geleert', () => {
  const plan = planDriver('Ali', [
    trip('2026-09-28', '08:00', '2026-09-28', '16:00'),
    trip('2026-09-29', '08:00', '2026-09-29', '16:00'),
    trip('2026-09-30', '08:00', '2026-09-30', '16:00'),
  ])
  assert.equal(plan.ruheTage, 0)
  assert.equal(plan.workDays, 3)
})

test('CSV liest nur abgeschlossene Fahrten und trennt Fahrer', () => {
  const csv = [
    'Vorname des Fahrers,Nachname des Fahrers,Zeitpunkt der Fahrtbestellung,Ankunftszeit der Fahrt,Fahrtstatus',
    'Ahmad Nabi,Azzad,2026-09-08 08:00:00,2026-09-08 12:00:00,completed',
    'Ahmad Nabi,Azzad,2026-09-08 12:30:00,2026-09-08 16:00:00,completed',
    'Nasiri,Wahidullah,2026-09-08 09:00:00,2026-09-08 13:00:00,completed',
    'Ahmad Nabi,Azzad,2026-09-08 18:00:00,2026-09-08 19:00:00,driver_canceled',
  ].join('\n')
  const plans = buildPlansFromCsv([csv])
  assert.deepEqual(plans.map((p) => p.name), ['Ahmad Nabi Azzad', 'Nasiri Wahidullah'])
  const ahmad = plans[0].days.find((d) => d.date === '2026-09-08')
  assert.equal(ahmad?.shifts.length, 1)
  assert.equal(ahmad?.shifts[0].paidH, 8)
})

test('Jeder Kalendertag ist eine Zeile von Di 01.09 bis Mi 30.09', () => {
  const plan = planDriver('Nori', [
    trip('2026-09-01', '08:00', '2026-09-01', '16:00'),
    trip('2026-09-08', '08:00', '2026-09-08', '12:00'),
    trip('2026-09-08', '23:00', '2026-09-09', '02:00'),
  ])
  assert.equal(plan.days.length, 30)
  const first = dayRow(plan.days[0])
  assert.equal(first.tag, 'Di 01.09')
  assert.equal(first.start, '08:00')
  assert.equal(first.ende, '16:00')
  // Bezahlte Arbeitszeit = Spanne 8 h minus 0,5 h Pflichtpause (Pause unbezahlt).
  assert.equal(first.stunden, 7.5)
  const doppelt = dayRow(plan.days.find((d) => d.date === '2026-09-08')!)
  assert.equal(doppelt.tag, 'Di 08.09')
  assert.equal(doppelt.start, '08:00 / 23:00')
  assert.equal(doppelt.ende, '12:00 / 02:00 +1')
  assert.equal(doppelt.pause, '0,00 / 0,00')
  assert.equal(doppelt.stunden, 7)
  const last = dayRow(plan.days[29])
  assert.equal(last.tag, 'Mi 30.09')
  assert.equal(last.start, '')
  assert.equal(last.stunden, null)
  const frei = dayRow(plan.days.find((d) => d.kind === 'frei')!)
  assert.equal(frei.hinweis, '')
  const zeilen = timesheetLines(plan)
  const erste = zeilen.find((z) => z.isoDate === '2026-09-01' && !z.isFree)
  assert.equal(erste?.startMin, 8 * 60)
  assert.equal(erste?.endMin, 8 * 60 + 8.5 * 60)
  assert.equal(erste?.breakMinutes, 30)
  assert.equal(erste?.paidHours, 8.5)
  assert.equal(erste?.breakOffsetMin, Math.round((8.5 * 60 - 30) / 2))
  const doppeltZeilen = zeilen.filter((z) => z.isoDate === '2026-09-08' && !z.isFree)
  assert.equal(doppeltZeilen.length, 2)
  assert.equal(doppeltZeilen[1].ruheH, 11)
  assert.ok(zeilen.length >= 30)
})
