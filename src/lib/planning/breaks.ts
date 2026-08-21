// Pausenregelung nach § 4 ArbZG, mit betrieblichem Spielraum nach oben:
//
//   Nettoarbeitszeit          Mindestpause
//   unter 6 Std.               0 Min. (keine Pflichtpause)
//   6 bis 9 Std.              30 Min.
//   ueber 9 Std.              45 Min.
//
// Nach oben ist eine Pause bis 120 Minuten zulaessig (MAX_BREAK_MINUTES in
// hoursMode.ts) - das ArbZG schreibt nur ein Minimum vor, keine Hoechstdauer.
// Der Planer waehlt innerhalb dieses Rahmens 30-120 Min., damit nicht jeder
// Tag dieselbe Pausenlaenge traegt. Niemals Bloecke unter 15 Minuten.

/** Zulaessiger Pausenrahmen je Schicht - Untergrenze wie Obergrenze. */
export const MIN_BREAK_MINUTES = 30
export const MAX_BREAK_MINUTES = 120

/** Gesetzliche Mindestpause (§ 4 ArbZG) fuer eine gegebene Nettoarbeitszeit. */
export function requiredBreakMinutes(netWorkHours: number): number {
  if (netWorkHours > 9) return 45
  if (netWorkHours >= 6) return 30
  return 0
}

/**
 * Erzeugt einen einzelnen, gesetzeskonformen Pausenblock (Minuten seit
 * Schichtbeginn) für eine gegebene Gesamt-Minutenzahl. `totalMinutes` kann
 * größer als das gesetzliche Minimum sein (z. B. bewusst länger vom
 * Disponenten eingetragen) - wird dann als EIN zusammenhängender Block
 * platziert, niemals als mehrere kleine, "zufällig" wirkende Blöcke.
 */
export function positionBreak(spanMinutes: number, totalMinutes: number, earliestAfterHours = 2, latestAfterHours = 6): { start: number; end: number }[] {
  if (totalMinutes <= 0 || spanMinutes <= 0) return []

  const earliestMin = Math.max(0, Math.round(earliestAfterHours * 60))
  const latestMin = Math.max(earliestMin, Math.round(latestAfterHours * 60))
  const latestPossibleStart = Math.max(0, spanMinutes - totalMinutes)

  const windowStart = Math.min(earliestMin, latestPossibleStart)
  const windowEnd = Math.min(latestMin, latestPossibleStart)

  let anchor = (windowStart + windowEnd) / 2
  anchor = Math.round(anchor / 5) * 5
  anchor = Math.max(0, Math.min(anchor, latestPossibleStart))

  return [{ start: anchor, end: anchor + totalMinutes }]
}

/**
 * Prüft eine Liste von Pausenblöcken (Minuten seit Schichtbeginn) auf
 * Gesetzeskonformität: gesetzliche Mindestpause erfüllt, keine Blöcke unter
 * 15 Minuten, keine Überschneidungen, Pause innerhalb der Schicht.
 */
export function validateBreaks(
  netWorkHours: number,
  spanMinutes: number,
  breaks: { start: number; end: number }[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const required = requiredBreakMinutes(netWorkHours)

  const sorted = [...breaks].sort((a, b) => a.start - b.start)

  for (const b of sorted) {
    if (b.end <= b.start) errors.push('Ein Pausenblock hat kein gültiges Ende.')
    if (b.end - b.start > 0 && b.end - b.start < 15) errors.push(`Pausenblock ${minToClock(b.start)}–${minToClock(b.end)} ist kürzer als 15 Minuten.`)
    if (b.start < 0 || b.end > spanMinutes) errors.push(`Pausenblock ${minToClock(b.start)}–${minToClock(b.end)} liegt außerhalb der Schicht.`)
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) errors.push('Zwei Pausenblöcke überschneiden sich.')
  }

  const legalMinutes = sorted.filter((b) => b.end - b.start >= 15).reduce((sum, b) => sum + (b.end - b.start), 0)
  if (legalMinutes < required) {
    errors.push(`Arbeitszeit ${netWorkHours.toFixed(1)} Std. erfordert mind. ${required} Minuten gesetzliche Pause (aktuell ${legalMinutes} Min. anrechenbar).`)
  }

  return { valid: errors.length === 0, errors }
}

function minToClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
