// Bewertet, wie gut ein Zeitfenster [startMin, endMin) mit den vom
// Administrator konfigurierten Nachfrageprofilen übereinstimmt (siehe
// Einstellungen -> Nachfrageprofile). Verwendet AUSSCHLIESSLICH die
// konfigurierten Profile - keine im Code fest hinterlegte Heuristik.

export type DemandLevel = 'niedrig' | 'mittel' | 'hoch' | 'sehr_hoch'
export type DemandProfileInput = { weekday: number; startTime: string; endTime: string; level: DemandLevel }

const LEVEL_WEIGHT: Record<DemandLevel, number> = {
  niedrig: 0.5,
  mittel: 1,
  hoch: 1.5,
  sehr_hoch: 2
}

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

// Position eines Nachfrageprofil-Zeitfensters in einer "erweiterten Woche"
// (Minuten seit Montag 00:00, kann > 7*1440 reichen bei Fenstern über
// Mitternacht/Wochenwechsel hinweg, z. B. Fr 16:00-Sa 03:00).
function profileRangeInWeekMinutes(p: DemandProfileInput): { start: number; end: number } {
  const toMondayIdx = (dow: number) => (dow === 0 ? 6 : dow - 1)
  const start = toMondayIdx(p.weekday) * 1440 + timeToMin(p.startTime)
  let end = toMondayIdx(p.weekday) * 1440 + timeToMin(p.endTime)
  if (end <= start) end += 1440 // Fenster reicht über Mitternacht hinaus
  return { start, end }
}

/**
 * Bewertet die Nachfrage-Abdeckung einer Schicht [startMin, endMin) an
 * einem gegebenen Wochentag (0=So..6=Sa). startMin/endMin sind Minuten seit
 * Mitternacht DES SCHICHTBEGINNS (endMin kann > 1440 sein bei
 * Übernacht-Schichten).
 */
export function demandScore(startMin: number, endMin: number, weekday: number, profiles: DemandProfileInput[]): number {
  const toMondayIdx = (dow: number) => (dow === 0 ? 6 : dow - 1)
  const dayOffset = toMondayIdx(weekday) * 1440
  const shiftStart = dayOffset + startMin
  const shiftEnd = dayOffset + endMin

  let score = 0
  profiles.forEach((p) => {
    const { start: baseStart, end: baseEnd } = profileRangeInWeekMinutes(p)
    const weight = LEVEL_WEIGHT[p.level]
    // Gegen die aktuelle und die Vor-/Folgewoche prüfen, falls die Schicht
    // am Wochenrand liegt (z. B. Sonntagnacht-Schicht vs. Montagsprofil).
    ;[-7 * 1440, 0, 7 * 1440].forEach((offset) => {
      const s = Math.max(shiftStart, baseStart + offset)
      const e = Math.min(shiftEnd, baseEnd + offset)
      if (e > s) score += (e - s) * weight
    })
  })
  return score
}
