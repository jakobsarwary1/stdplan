/**
 * Standard-Schichtmodelle, die ein neues Unternehmen automatisch erhält
 * (siehe Super-Prompt Abschnitt 5.6). Schichten beschreiben einen RAHMEN
 * (frühester/spätester Beginn, Netto-Arbeitszeit, max. Schichtdauer) -
 * keine festen Uhrzeiten. Die Auto-Planung (Phase 4) berechnet daraus
 * täglich die konkrete Startzeit.
 */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const MON_FRI = [1, 2, 3, 4, 5]

type ShiftSeed = {
  name: string
  description?: string
  driverCount?: number
  weekdays?: number[]
  requiredQualification?: string
  earliestStart: string
  latestStart: string
  targetNetHours: number
  maxShiftHours: number
  flexibleStart?: boolean
  prioritizeDemand?: boolean
  optimizeNightSurcharge?: boolean
  autoBreak?: boolean
}

type TemplateSeed = {
  name: string
  description: string
  isDefault?: boolean
  singleDriverMode?: boolean
  mode?: 'fixed' | 'flexible'
  shifts: ShiftSeed[]
}

export const SHIFT_TEMPLATE_SEEDS: TemplateSeed[] = [
  {
    name: 'Einzelfahrer',
    description: 'Ein Fahrzeug wird dauerhaft einem Stammfahrer zugeordnet. Keine feste Startzeit erforderlich.',
    isDefault: true,
    singleDriverMode: true,
    shifts: [
      {
        name: 'Tagschicht', weekdays: MON_FRI, earliestStart: '04:00', latestStart: '10:00',
        targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true
      }
    ]
  },
  {
    name: 'Einzelfahrer mit Vertretung',
    description: 'Wie „Einzelfahrer" – die Auto-Planung sucht bei Abwesenheit des Stammfahrers automatisch eine Vertretung.',
    singleDriverMode: true,
    shifts: [
      {
        name: 'Tagschicht', weekdays: MON_FRI, earliestStart: '04:00', latestStart: '10:00',
        targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true
      }
    ]
  },
  {
    name: '2-Schicht-Betrieb',
    description: 'Ein Fahrzeug wird täglich von zwei Fahrern genutzt.',
    shifts: [
      { name: 'Frühschicht', earliestStart: '05:00', latestStart: '07:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true },
      { name: 'Spätschicht', earliestStart: '13:00', latestStart: '15:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true }
    ]
  },
  {
    name: '3-Schicht-Betrieb',
    description: 'Ein Fahrzeug fährt nahezu rund um die Uhr.',
    shifts: [
      { name: 'Früh', earliestStart: '04:00', latestStart: '06:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true },
      { name: 'Spät', earliestStart: '12:00', latestStart: '14:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true },
      { name: 'Nacht', earliestStart: '20:00', latestStart: '22:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, optimizeNightSurcharge: true }
    ]
  },
  {
    name: 'Wochenendbetrieb',
    description: 'Montag–Freitag normale Schichten, Samstag/Sonntag zusätzliche Nachtschicht.',
    shifts: [
      { name: 'Frühschicht', weekdays: ALL_DAYS, earliestStart: '05:00', latestStart: '07:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true },
      { name: 'Spätschicht', weekdays: ALL_DAYS, earliestStart: '13:00', latestStart: '15:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, prioritizeDemand: true },
      { name: 'Wochenend-Nachtschicht', weekdays: [0, 6], earliestStart: '21:00', latestStart: '23:00', targetNetHours: 8, maxShiftHours: 9, flexibleStart: true, optimizeNightSurcharge: true }
    ]
  },
  {
    name: 'Individuelles Modell',
    description: 'Leere Vorlage zum freien Konfigurieren.',
    shifts: [
      { name: 'Schicht 1', earliestStart: '06:00', latestStart: '09:00', targetNetHours: 8, maxShiftHours: 9 }
    ]
  },
  {
    name: 'Flexible Schicht',
    description: 'Schichten werden anhand der erwarteten Nachfrage erzeugt (Fahrer-Modus der Auto-Planung).',
    mode: 'flexible',
    shifts: []
  }
]

type DemandSeed = { weekday: number; startTime: string; endTime: string; level: 'niedrig' | 'mittel' | 'hoch' | 'sehr_hoch' }

// Beispiel-Startwerte aus dem Super-Prompt Abschnitt 5.8 - später vom
// Administrator unter "Einstellungen -> Nachfrageprofile" frei änderbar.
export const DEMAND_PROFILE_SEEDS: DemandSeed[] = [
  // Montag = 1
  { weekday: 1, startTime: '06:00', endTime: '09:00', level: 'hoch' },
  { weekday: 1, startTime: '09:00', endTime: '15:00', level: 'niedrig' },
  { weekday: 1, startTime: '15:00', endTime: '20:00', level: 'hoch' },
  { weekday: 1, startTime: '20:00', endTime: '06:00', level: 'mittel' },
  // Dienstag-Donnerstag = 2-4, wie Montag
  ...([2, 3, 4] as const).flatMap((weekday) => [
    { weekday, startTime: '06:00', endTime: '09:00', level: 'hoch' as const },
    { weekday, startTime: '09:00', endTime: '15:00', level: 'niedrig' as const },
    { weekday, startTime: '15:00', endTime: '20:00', level: 'hoch' as const },
    { weekday, startTime: '20:00', endTime: '06:00', level: 'mittel' as const }
  ]),
  // Freitag = 5
  { weekday: 5, startTime: '06:00', endTime: '10:00', level: 'hoch' },
  { weekday: 5, startTime: '10:00', endTime: '16:00', level: 'mittel' },
  { weekday: 5, startTime: '16:00', endTime: '03:00', level: 'sehr_hoch' },
  { weekday: 5, startTime: '03:00', endTime: '06:00', level: 'niedrig' },
  // Samstag = 6
  { weekday: 6, startTime: '00:00', endTime: '05:00', level: 'sehr_hoch' },
  { weekday: 6, startTime: '05:00', endTime: '09:00', level: 'niedrig' },
  { weekday: 6, startTime: '09:00', endTime: '16:00', level: 'mittel' },
  { weekday: 6, startTime: '16:00', endTime: '05:00', level: 'sehr_hoch' },
  // Sonntag = 0
  { weekday: 0, startTime: '09:00', endTime: '14:00', level: 'hoch' },
  { weekday: 0, startTime: '14:00', endTime: '17:00', level: 'niedrig' },
  { weekday: 0, startTime: '17:00', endTime: '23:00', level: 'hoch' },
  { weekday: 0, startTime: '23:00', endTime: '09:00', level: 'niedrig' }
]
