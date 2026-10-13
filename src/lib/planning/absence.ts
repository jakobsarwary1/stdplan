/**
 * Abwesenheitsarten, die im Dienstplan je Tag gewählt werden können.
 *
 * Bewusst ein eigenes Modul: actions.ts ist eine 'use server'-Datei und darf
 * ausschliesslich async-Funktionen exportieren – Konstanten und Hilfsfunktionen
 * wuerden dort die gesamte Seite am Kompilieren hindern.
 *
 * Fuer die Planung wirken alle drei Arten gleich (an dem Tag entsteht keine
 * Schicht); unterschieden werden sie fuer Lohnabrechnung und Nachweis.
 */
export type AbsenceKind = 'frei' | 'urlaub' | 'krank'

export const ABSENCE_LABEL: Record<AbsenceKind, string> = {
  frei: 'Frei',
  urlaub: 'Beurlaubt',
  krank: 'Krankgeschrieben',
}

/** Liest "YYYY-MM-DD:art, YYYY-MM-DD" – die Art ist optional, Vorgabe "frei". */
export function parseAbsences(raw: string): Map<string, AbsenceKind> {
  const map = new Map<string, AbsenceKind>()
  raw.split(',').forEach((eintrag) => {
    const [datum, art] = eintrag.trim().split(':')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum ?? '')) return
    map.set(datum, art === 'urlaub' || art === 'krank' ? art : 'frei')
  })
  return map
}
