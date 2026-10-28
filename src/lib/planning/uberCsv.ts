// Alle Fahrer eines Monats in EINER CSV – jeder Fahrer als eigene, durch eine
// Leerzeile getrennte Tabelle (Tag/Start/Ende/Pause/Stunden/Hinweis + Summe).
// Deutsches Format: Semikolon-Trenner, Komma-Dezimal, UTF-8-BOM (Excel-freundlich).
import { dayRow, monthLabelDE, type DriverPlan } from './uberPlan'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Eine Zelle: Zahl → Komma-Dezimal; Semikolon/Anführungszeichen/Zeilenumbruch maskiert. */
function cell(v: string | number | null): string {
  if (v == null) return ''
  let s = typeof v === 'number' ? v.toFixed(2).replace('.', ',') : String(v)
  if (/[";\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}
const row = (...cols: (string | number | null)[]) => cols.map(cell).join(';')

const KOPF = ['Tag', 'Start', 'Ende', 'Pause (h)', 'Stunden', 'Hinweis']

/** Baut die Gesamt-CSV für alle Fahrer-Pläne eines Monats. */
export function buildCsvForPlans(plans: DriverPlan[]): { csv: string; monthLabel: string } {
  const monthYm = plans.find((p) => p.month)?.month ?? ''
  const monatLabel = monthYm ? monthLabelDE(monthYm) : 'Monat'

  // Meiste Stunden zuerst (wie im Excel), stabil über den Namen.
  const sortiert = [...plans].sort((a, b) => b.paidH - a.paidH || a.name.localeCompare(b.name))

  const bloecke = sortiert.map((p) => {
    const z: string[] = []
    z.push(row(`${p.name} — Stundenzettel ${monatLabel}`))
    z.push(KOPF.join(';'))
    for (const day of p.days) {
      const d = dayRow(day)
      z.push(row(d.tag, d.start, d.ende, d.pause, d.stunden, d.hinweis))
    }
    z.push(row('Summe', '', '', '', round2(p.nettoH), `${p.workDays} Arbeitstage · ${p.freeDays} frei · ${p.ruheTage} Ruhetag`))
    return z.join('\r\n')
  })

  return { csv: '﻿' + bloecke.join('\r\n\r\n') + '\r\n', monthLabel: monatLabel }
}
