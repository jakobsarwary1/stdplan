const EMPLOYEE_NUMBER_PAD_WIDTH = 6

/**
 * Füllt eine rein numerische Personalnummer intern mit führenden Nullen auf
 * eine feste Länge auf (z. B. "12" -> "000012"), damit die alphabetische
 * Sortierung in der Datenbank mit der numerischen Reihenfolge
 * übereinstimmt (sonst: 1, 12, 2, 23, 3, ... statt 1, 2, 3, ... 12, 23).
 * Nicht-numerische Werte (falls doch mal Buchstaben verwendet werden)
 * bleiben unverändert. Wird beim Speichern angewendet, beim Anzeigen
 * wieder entfernt (siehe stripEmployeeNumberPadding) - die Nullen sind im
 * Frontend nie sichtbar.
 */
export function padEmployeeNumber(raw: string | null): string | null {
  if (!raw) return null
  if (!/^\d+$/.test(raw)) return raw
  return raw.padStart(EMPLOYEE_NUMBER_PAD_WIDTH, '0')
}

/** Entfernt die von padEmployeeNumber hinzugefügten führenden Nullen wieder, für die Anzeige. */
export function stripEmployeeNumberPadding(padded: string | null | undefined): string {
  if (!padded) return ''
  if (!/^\d+$/.test(padded)) return padded
  return String(parseInt(padded, 10))
}
