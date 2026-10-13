const WEEKDAY_SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

/** "2026-06-01" -> "Mo. 01.06.26" */
export function fmtDateDEWithWeekday(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  const yy = String(y).slice(-2)
  return `${WEEKDAY_SHORT_DE[dow]}. ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${yy}`
}

export function minToClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Pausenblöcke (Minuten seit Schichtbeginn) als "10:30–11:00 (30 min)" bzw. bei mehreren "10:30–10:45 (15 min), 13:00–13:15 (15 min)" */
export function formatBreakRanges(shiftStartMin: number, breaks: { start: number; end: number }[]): string {
  if (breaks.length === 0) return '—'
  return breaks
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((b) => `${minToClock(shiftStartMin + b.start)}–${minToClock(shiftStartMin + b.end)} (${b.end - b.start} min)`)
    .join(', ')
}
