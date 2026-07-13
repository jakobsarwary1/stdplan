import { requiredBreakMinutes, positionBreak } from './breaks'
import { demandScore, type DemandProfileInput } from './demand'

export type ShiftFrame = {
  earliestStart: string
  latestStart: string
  targetNetHours: number
  maxShiftHours: number
  flexibleStart: boolean
  prioritizeDemand: boolean
  optimizeNightSurcharge: boolean
  autoBreak: boolean
}

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function nightOverlapMinutes(startMin: number, endMin: number, nightStartMin: number, nightEndMin: number): number {
  const dur = nightEndMin <= nightStartMin ? 1440 - nightStartMin + nightEndMin : nightEndMin - nightStartMin
  const winStart = nightStartMin
  const winEnd = nightStartMin + dur
  const s = Math.max(startMin, winStart)
  const e = Math.min(endMin, winEnd)
  return Math.max(0, e - s)
}

export type ShiftTiming = { startMin: number; endMin: number; breakMinutes: number; netHours: number }

/**
 * Berechnet aus dem Schicht-RAHMEN (Startfenster, Ziel-Netto-Arbeitszeit)
 * die konkrete Startzeit für einen gegebenen Wochentag.
 *
 * WICHTIG (behobener Fehler): `targetNetHours`/`maxShiftHours` werden auf
 * einen sinnvollen Mindestwert abgesichert - eine leere/ungültige Eingabe
 * (0 oder NaN) darf NIEMALS zu einer 0-Minuten-Schicht (Start = Ende)
 * führen. In diesem Fall wird ein Fehler geworfen, statt eine defekte
 * Schicht stillschweigend zu erzeugen (siehe generateSlotsForVehicle, das
 * diesen Fall abfängt und die Schicht überspringt statt sie zu erzeugen).
 */
export function computeShiftTiming(
  frame: ShiftFrame,
  weekday: number,
  demandProfiles: DemandProfileInput[],
  nightStartStr: string,
  nightEndStr: string
): ShiftTiming {
  const targetNetHours = Number(frame.targetNetHours)
  const maxShiftHours = Number(frame.maxShiftHours)

  if (!Number.isFinite(targetNetHours) || targetNetHours <= 0) {
    throw new Error('Ungültige Netto-Arbeitszeit im Schichtmodell (0 oder leer) - Schichtmodell bitte prüfen.')
  }

  const earliestMin = timeToMin(frame.earliestStart)
  let latestMin = timeToMin(frame.latestStart)
  if (latestMin < earliestMin) latestMin += 1440 // Fenster über Mitternacht

  const targetNetMinutes = Math.round(targetNetHours * 60)
  const breakMinutes = frame.autoBreak ? requiredBreakMinutes(targetNetMinutes / 60) : 0

  let spanMinutes = targetNetMinutes + breakMinutes
  const maxSpanMinutes = Math.round((Number.isFinite(maxShiftHours) && maxShiftHours > 0 ? maxShiftHours : targetNetHours) * 60)
  if (spanMinutes > maxSpanMinutes) spanMinutes = Math.max(maxSpanMinutes, breakMinutes + 15) // nie unter Pause + Mindestarbeit

  const nightStartMin = timeToMin(nightStartStr || '22:00')
  const nightEndMin = timeToMin(nightEndStr || '06:00')

  // Beide Signale liefern je einen Score für einen Kandidaten. Nachtzuschlag
  // hat Vorrang (primäres Kriterium, wie im Super-Prompt vorgegeben), aber
  // bei mehreren Kandidaten mit GLEICHER Nachtüberlappung entscheidet die
  // Nachfrage als zweites Kriterium - sonst wäre das Ergebnis an jedem
  // Wochentag identisch, weil sich das Nachtfenster (22-06 Uhr) nicht nach
  // Wochentag unterscheidet, die Nachfrage aber schon.
  function scoresFor(startMin: number): [number, number] {
    const endMin = startMin + spanMinutes
    const night = frame.optimizeNightSurcharge ? nightOverlapMinutes(startMin, endMin, nightStartMin, nightEndMin) : 0
    const demand = frame.prioritizeDemand ? demandScore(startMin, endMin, weekday, demandProfiles) : 0
    return [night, demand]
  }

  let bestStart = earliestMin
  if (frame.optimizeNightSurcharge || frame.prioritizeDemand) {
    let bestNight = -Infinity
    let bestDemand = -Infinity
    let bestCandidates: number[] = []
    for (let cand = earliestMin; cand <= latestMin; cand += 15) {
      const [night, demand] = scoresFor(cand)
      if (night > bestNight || (night === bestNight && demand > bestDemand)) {
        bestNight = night
        bestDemand = demand
        bestCandidates = [cand]
      } else if (night === bestNight && demand === bestDemand) {
        bestCandidates.push(cand)
      }
    }
    // Bei weiterhin bestehendem Gleichstand die MITTE der bestplatzierten
    // Kandidaten wählen (nicht immer die früheste) - fühlt sich natürlicher
    // an und vermeidet, dass die Auto-Planung bei vielen gleichwertigen
    // Optionen immer denselben Randwert liefert.
    bestStart = bestCandidates[Math.floor(bestCandidates.length / 2)] ?? earliestMin
  }
  // ohne Priorisierung: bewusst deterministisch die früheste erlaubte Zeit

  const netHours = (spanMinutes - breakMinutes) / 60

  return { startMin: bestStart, endMin: bestStart + spanMinutes, breakMinutes, netHours }
}

export function timingToBreakBlocks(spanMinutes: number, breakMinutes: number) {
  return positionBreak(spanMinutes, breakMinutes)
}
