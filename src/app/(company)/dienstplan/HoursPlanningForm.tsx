'use client'

import { useState } from 'react'
import { useFormState, useFormStatus } from 'react-dom'
import { Badge, Button, Card } from '@/components/ui'
import { applyHoursPlanning, previewHoursPlanning, type HoursPreviewState } from './actions'
import { fmtDateDEWithWeekday, formatBreakRanges, minToClock } from '@/lib/planning/format'
import { stripEmployeeNumberPadding } from '@/lib/employeeNumber'

const INITIAL_STATE: HoursPreviewState = { vehicleId: '', shifts: [], warnings: [], error: null }
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

/**
 * Berechnet je Fahrer die tatsächlich gearbeiteten Stunden (Pause
 * ausgenommen) und ordnet sie den steuerlichen Zuschlagskategorien nach
 * § 3b EStG zu: 25 % für 20-24 Uhr und 04-06 Uhr, 40 % (steuerfrei) für
 * 00-04 Uhr, 50 % für Sonntagsarbeit. Zuschläge sind kumulativ (eine
 * Sonntagsnachtstunde zählt für beide Kategorien), daher separate Summen.
 */
function computeSurcharges(rows: import('./actions').HoursPreviewRow[]) {
  let totalNet = 0, night25 = 0, night40 = 0, sunday50 = 0

  rows.filter((r) => !r.isFree && r.startMin != null && r.endMin != null && r.breaks).forEach((r) => {
    const [y, m, d] = r.date.split('-').map(Number)
    const shiftStart = new Date(y, m - 1, d, 0, r.startMin!, 0, 0)
    const shiftEnd = new Date(y, m - 1, d, 0, r.endMin!, 0, 0)

    let workIntervals: { start: Date; end: Date }[] = [{ start: shiftStart, end: shiftEnd }]
    r.breaks!.forEach((b) => {
      const bStart = new Date(shiftStart.getTime() + b.start * 60000)
      const bEnd = new Date(shiftStart.getTime() + b.end * 60000)
      workIntervals = workIntervals.flatMap((w) => {
        if (bEnd <= w.start || bStart >= w.end) return [w]
        const parts: { start: Date; end: Date }[] = []
        if (bStart > w.start) parts.push({ start: w.start, end: bStart })
        if (bEnd < w.end) parts.push({ start: bEnd, end: w.end })
        return parts
      })
    })

    workIntervals.forEach((w) => {
      totalNet += (w.end.getTime() - w.start.getTime()) / 3600000
      let cursor = new Date(w.start)
      while (cursor < w.end) {
        const dayBase = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
        const nextDay = new Date(dayBase.getTime() + 86400000)
        const segEnd = new Date(Math.min(w.end.getTime(), nextDay.getTime()))
        const segStartMin = (cursor.getTime() - dayBase.getTime()) / 60000
        const segEndMin = (segEnd.getTime() - dayBase.getTime()) / 60000
        const isSunday = dayBase.getDay() === 0
        const ov = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
        night40 += ov(segStartMin, segEndMin, 0, 240) / 60
        night25 += (ov(segStartMin, segEndMin, 240, 360) + ov(segStartMin, segEndMin, 1200, 1440)) / 60
        if (isSunday) sunday50 += (segEndMin - segStartMin) / 60
        cursor = segEnd
      }
    })
  })

  return { totalNet, night25, night40, sunday50 }
}

/**
 * Zusätzliche Kennzahlen: freie Tage im Monat, Anzahl Spesen-berechtigter
 * Tage (nur wenn "Spesen berechnen" für den Fahrer aktiv war), geschätztes
 * Spesengeld (pauschal 14 € je Tag - aktueller gesetzlicher
 * Verpflegungsmehraufwand bei >8 Std. Abwesenheit nach § 9 Abs. 4a EStG,
 * Stand prüfen, ändert sich gelegentlich) sowie ein grob geschätzter
 * Bruttolohn (Nettostunden × hinterlegter Stundenlohn, OHNE Zuschläge -
 * echte Lohnabrechnung mit Zuschlägen folgt in einer späteren Phase).
 */
function computeExtendedStats(rows: import('./actions').HoursPreviewRow[]) {
  const freeDays = rows.filter((r) => r.isFree).length
  const workDays = rows.filter((r) => !r.isFree)
  // Spesen (Verpflegungsmehraufwand) stehen gesetzlich erst ab einer
  // ANWESENHEIT von mindestens 8 Std. zu (§ 9 Abs. 4a EStG) - das
  // "Spesen berechnen"-Häkchen allein reicht nicht, jeder einzelne Tag muss
  // die 8-Std.-Bruttogrenze tatsächlich erreichen.
  const spesenDays = workDays.filter((r) => {
    if (!r.calculateExpenses) return false
    const gross = (r.netHours ?? 0) + (r.breakMinutes ?? 0) / 60 + (r.commuteMinutes ?? 0) / 60
    return gross >= 7.99 // kleine Toleranz für Rundung
  }).length
  const spesenAmount = spesenDays * 14
  const totalNetHours = workDays.reduce((sum, r) => sum + (r.netHours ?? 0), 0)
  const hourlyRate = workDays.find((r) => r.hourlyRate != null)?.hourlyRate ?? null
  // Bruttolohn = Grundlohn (alle Netto-Std. × Stundenlohn) PLUS
  // Sonntagszuschlag 50 % auf die tatsächlich am Sonntag geleisteten
  // Stunden (zusätzlich zum ohnehin bereits enthaltenen Grundlohn für
  // diese Stunden) - Nachtzuschläge bleiben hier bewusst außen vor, da sie
  // steuerfrei sind und separat ausgewiesen werden.
  const { sunday50 } = computeSurcharges(workDays)
  const grossWage = hourlyRate != null ? totalNetHours * hourlyRate + sunday50 * hourlyRate * 0.5 : null
  return { freeDays, spesenDays, spesenAmount, grossWage, hourlyRate }
}

function Submit() {
  const { pending } = useFormStatus()
  return <Button type="submit" disabled={pending}>{pending ? 'Berechne…' : 'Dienstplan erzeugen'}</Button>
}

async function downloadPdf(
  rows: import('./actions').HoursPreviewRow[],
  title: string,
  options: { driverNames: string[]; includeFreeDays: boolean; includeSummary: boolean; columns: string[] }
) {
  const filteredRows = rows.filter((r) => options.driverNames.includes(r.driverName) && (options.includeFreeDays || !r.isFree))
  const sorted = [...filteredRows].sort((a, b) => a.driverName.localeCompare(b.driverName) || a.date.localeCompare(b.date))

  // Monat/Jahr für die Kopfzeile im PDF (z. B. "April 2026") aus den
  // tatsächlichen Zeilendaten ableiten - robuster als der Formular-Zustand,
  // da es exakt widerspiegelt, was generiert wurde.
  const firstDate = sorted[0]?.date
  const monthLabel = firstDate
    ? new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(new Date(firstDate + 'T00:00:00'))
    : ''

  // Zusammenhängende freie Tage (pro Fahrer, aufeinanderfolgende
  // Kalendertage) zu EINER Zeile zusammenfassen statt jeden Tag einzeln
  // aufzulisten - spart massiv Papier bei Fahrern mit vielen freien Tagen.
  type MergedFree = { driverName: string; fromDate: string; toDate: string; isFree: true; dayCount: number }
  type MergedWork = import('./actions').HoursPreviewRow & { isFree: false }
  const merged: (MergedFree | MergedWork)[] = []

  sorted.forEach((r) => {
    if (!r.isFree) {
      merged.push(r as MergedWork)
      return
    }
    const last = merged[merged.length - 1]
    const prevDay = new Date(r.date)
    prevDay.setDate(prevDay.getDate() - 1)
    const prevDateStr = `${prevDay.getFullYear()}-${String(prevDay.getMonth() + 1).padStart(2, '0')}-${String(prevDay.getDate()).padStart(2, '0')}`
    if (last && last.isFree && last.driverName === r.driverName && last.toDate === prevDateStr) {
      last.toDate = r.date
      last.dayCount += 1
    } else {
      merged.push({ driverName: r.driverName, fromDate: r.date, toDate: r.date, isFree: true, dayCount: 1 })
    }
  })

  const pdfRows = merged.map((r) => {
    if (r.isFree) {
      const label = r.dayCount === 1
        ? `frei (${fmtDateDEWithWeekday(r.fromDate)})`
        : `frei: ${fmtDateDEWithWeekday(r.fromDate)} bis ${fmtDateDEWithWeekday(r.toDate)} (${r.dayCount} Tage)`
      return {
        driverName: r.driverName,
        date: label,
        start: '', end: '', breakLabel: '', breakMinutes: 0, commuteMinutes: 0,
        netHours: 0, totalHours: 0,
        vehiclePlate: '',
        night25: 0, night40: 0, sunday50: 0,
        isFree: true
      }
    }
    const day = computeSurcharges([r])
    return {
      driverName: r.driverName,
      date: fmtDateDEWithWeekday(r.date),
      start: minToClock(r.startMin!),
      end: minToClock(r.endMin!),
      breakLabel: formatBreakRanges(r.startMin!, r.breaks!),
      breakMinutes: r.breakMinutes ?? 0,
      commuteMinutes: r.commuteMinutes ?? 0,
      netHours: r.netHours ?? 0,
      totalHours: (r.netHours ?? 0) + (r.breakMinutes ?? 0) / 60 + (r.commuteMinutes ?? 0) / 60,
      vehiclePlate: r.vehiclePlate,
      night25: day.night25,
      night40: day.night40,
      sunday50: day.sunday50,
      isFree: false
    }
  })

  // Zuschlags-Zusammenfassung pro Fahrer (und ggf. Gesamt) mit ins PDF
  // geben, damit z. B. der Sonntagszuschlag nicht nur auf dem Bildschirm,
  // sondern auch im heruntergeladenen Dokument sichtbar ist. Nur für
  // ausgewählte Fahrer, und nur wenn die Zusammenfassung gewünscht ist.
  const selectedDriverNames = options.driverNames
  const summaries = options.includeSummary
    ? selectedDriverNames.map((name) => {
        const s = computeSurcharges(rows.filter((r) => r.driverName === name && !r.isFree))
        const { grossWage } = computeExtendedStats(rows.filter((r) => r.driverName === name))
        return { driverName: name, ...s, grossWage }
      })
    : []
  if (options.includeSummary && selectedDriverNames.length > 1) {
    const combined = computeSurcharges(rows.filter((r) => selectedDriverNames.includes(r.driverName) && !r.isFree))
    const combinedGrossWage = summaries.reduce((sum, s) => (s.grossWage != null ? sum + s.grossWage : sum), 0)
    const anyHasWage = summaries.some((s) => s.grossWage != null)
    summaries.push({ driverName: 'Gesamt (alle Fahrer)', ...combined, grossWage: anyHasWage ? combinedGrossWage : null })
  }

  try {
    const vehiclePlateForHeader = sorted.find((r) => !r.isFree)?.vehiclePlate ?? ''
    const res = await fetch('/api/dienstplan/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, rows: pdfRows, summaries, monthLabel, columns: options.columns, vehiclePlate: vehiclePlateForHeader })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      alert(`PDF-Erzeugung fehlgeschlagen (${res.status}). ${text.slice(0, 300)}`)
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url

    // Dateiname im Format Plan_[Monat][Jahr]_[Pers.-Nr.]_[Nachname]_[Fahrzeug].pdf
    // Bei mehreren ausgewählten Fahrern (Pers.-Nr./Nachname wären dann nicht
    // eindeutig) fällt der Name auf Plan_[Monat][Jahr]_[Fahrzeug] zurück.
    const selectedRows = rows.filter((r) => options.driverNames.includes(r.driverName))
    const uniqueDriverNames = Array.from(new Set(selectedRows.map((r) => r.driverName)))
    const vehiclePlateForFile = selectedRows.find((r) => !r.isFree)?.vehiclePlate ?? ''
    const monthFileLabel = monthLabel.replace(/\s+/g, '')
    let fileNameBase: string
    if (uniqueDriverNames.length === 1) {
      const driverRow = selectedRows.find((r) => r.driverName === uniqueDriverNames[0])
      const lastName = uniqueDriverNames[0].trim().split(' ').slice(-1)[0] || uniqueDriverNames[0]
      const rawPersNr = driverRow?.employeeNumber
      const persNr = rawPersNr ? stripEmployeeNumberPadding(rawPersNr) || 'ohnePersNr' : 'ohnePersNr'
      fileNameBase = `Plan_${monthFileLabel}_${persNr}_${lastName}_${vehiclePlateForFile}`
    } else {
      fileNameBase = `Plan_${monthFileLabel}_${vehiclePlateForFile}`
    }
    a.download = fileNameBase.replace(/[^a-zA-Z0-9_-]/g, '') + '.pdf'

    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    alert(`PDF-Erzeugung fehlgeschlagen: ${(err as Error).message}`)
  }
}

const PDF_COLUMN_OPTIONS = [
  { key: 'pause', label: 'Pause (nur Dauer)' },
  { key: 'weg', label: 'Weg' },
  { key: 'netto', label: 'Netto' },
  { key: 'gesamt', label: 'Gesamt (Brutto)' },
  { key: 'nacht25', label: 'Nacht 25 %' },
  { key: 'nacht40', label: 'Nacht 40 %' },
  { key: 'sonntag50', label: 'Sonntag 50 %' },
  { key: 'fahrzeug', label: 'Fahrzeug' }
] as const
type PdfColumnKey = typeof PDF_COLUMN_OPTIONS[number]['key']
const DEFAULT_PDF_COLUMNS: PdfColumnKey[] = ['pause', 'gesamt']

function PdfExportPanel({ rows }: { rows: import('./actions').HoursPreviewRow[] }) {
  const allDriverNames = Array.from(new Set(rows.map((r) => r.driverName)))
  const [open, setOpen] = useState(false)
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>(allDriverNames)
  const [includeFreeDays, setIncludeFreeDays] = useState(true)
  const [includeSummary, setIncludeSummary] = useState(true)
  const [selectedColumns, setSelectedColumns] = useState<PdfColumnKey[]>(DEFAULT_PDF_COLUMNS)

  function toggleDriver(name: string) {
    setSelectedDrivers((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  function toggleColumn(key: PdfColumnKey) {
    setSelectedColumns((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
        PDF
      </Button>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-sm">
      <p className="mb-3 font-semibold">Was soll ins PDF?</p>

      <p className="mb-1 text-xs text-textMuted">Fahrer</p>
      <div className="mb-3 flex flex-wrap gap-3">
        {allDriverNames.map((name) => (
          <label key={name} className="flex items-center gap-1.5">
            <input type="checkbox" checked={selectedDrivers.includes(name)} onChange={() => toggleDriver(name)} />
            {name}
          </label>
        ))}
      </div>

      <p className="mb-1 text-xs text-textMuted">Spalten (Fahrer, Datum, Von, Bis sind immer dabei)</p>
      <div className="mb-3 flex flex-wrap gap-3">
        {PDF_COLUMN_OPTIONS.map((col) => (
          <label key={col.key} className="flex items-center gap-1.5">
            <input type="checkbox" checked={selectedColumns.includes(col.key)} onChange={() => toggleColumn(col.key)} />
            {col.label}
          </label>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap gap-4">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={includeFreeDays} onChange={(e) => setIncludeFreeDays(e.target.checked)} />
          Freie Tage anzeigen
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={includeSummary} onChange={(e) => setIncludeSummary(e.target.checked)} />
          Monatszusammenfassung einschließen
        </label>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={selectedDrivers.length === 0}
          onClick={() => downloadPdf(rows, 'Dienstplan', { driverNames: selectedDrivers, includeFreeDays, includeSummary, columns: selectedColumns })}
        >
          PDF erstellen
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Abbrechen
        </Button>
      </div>
    </div>
  )
}

function ApplySubmit() {
  const { pending } = useFormStatus()
  return <Button type="submit" disabled={pending}>{pending ? 'Wird übernommen…' : 'Dienstplan übernehmen'}</Button>
}

function DriverFields({ index, drivers }: { index: 1 | 2; drivers: { id: string; name: string }[] }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 text-xs font-semibold uppercase text-textMuted">Fahrer {index}{index === 2 ? ' (optional)' : ''}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="field">
          <label className="label">Fahrer</label>
          <select name={`driver${index}Id`} className="input">
            <option value="">– keiner –</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label">Gesamtstunden Monat</label>
          <input type="number" step="0.5" min="0" name={`driver${index}TotalHours`} className="input" placeholder="130" />
        </div>
        <div className="field">
          <label className="label">davon Sonntagsstunden</label>
          <input type="number" step="0.5" min="0" name={`driver${index}SundayHours`} className="input" placeholder="32" />
        </div>
        <div className="field">
          <label className="label">Arbeitsweg (Min., je Schicht)</label>
          <input type="number" step="5" min="0" name={`driver${index}CommuteMinutes`} className="input" defaultValue={30} />
        </div>
        <div className="field">
          <label className="label">Pausenlänge (Min., optional)</label>
          <input type="number" step="5" min="0" name={`driver${index}BreakMinutes`} className="input" placeholder="leer = gesetzliches Minimum" />
        </div>
        <div className="field">
          <label className="label">Spesen-Tage (Anzahl, optional)</label>
          <input type="number" step="1" min="0" name={`driver${index}SpesenDaysTarget`} className="input" placeholder="z. B. 10" />
          <p className="mt-1 text-xs text-textMuted">Anzahl Tage mit mind. 8 Std. Gesamtzeit (= Spesen-berechtigt). Ohne dieses Feld gilt weiterhin "alle in Frage kommenden Tage" (bei Spesen-Häkchen/Vollzeit).</p>
        </div>
        <label className="mt-6 flex items-center gap-2 text-sm">
          <input type="checkbox" name={`driver${index}IsEinzelfahrer`} defaultChecked={index === 1} />
          Einzelfahrer/Vollzeit-Muster (feste Fr/Sa/So-Vorlage, 8h-Mindestgesamtzeit, nie 3 Tage frei)
        </label>
        <label className="mt-6 flex items-center gap-2 text-sm">
          <input type="checkbox" name={`driver${index}CalculateExpenses`} defaultChecked={index === 1} />
          Spesen berechnen (erzwingt 8–10 Std. Gesamtzeit)
        </label>
        <label className="mt-6 flex items-center gap-2 text-sm">
          <input type="checkbox" name={`driver${index}PrioritizeDemand`} />
          Nachfrage priorisieren (z. B. Einzelfahrer-Fahrzeuge)
        </label>
        <label className="mt-6 flex items-center gap-2 text-sm">
          <input type="checkbox" name={`driver${index}PrioritizeSunday`} />
          Sonntagszuschlag priorisieren
        </label>
        <label className="mt-6 flex items-center gap-2 text-sm">
          <input type="checkbox" name={`driver${index}MaximizeNight`} defaultChecked={index === 1} />
          Nachtzuschläge maximieren
        </label>
      </div>
    </div>
  )
}

export function HoursPlanningForm({
  vehicles,
  drivers,
  defaultYear,
  defaultMonth
}: {
  vehicles: { id: string; licensePlate: string }[]
  drivers: { id: string; name: string }[]
  defaultYear: number
  defaultMonth: number
}) {
  const [state, formAction] = useFormState(previewHoursPlanning, INITIAL_STATE)

  return (
    <Card className="mb-6">
      <h2 className="mb-1 font-semibold">Stundenbasierte Planung (Dokumentation)</h2>
      <p className="mb-4 text-sm text-textMuted">
        Für vergangene Monate oder reine Dokumentationszwecke: Gesamtstunden je Fahrer vorgeben (inkl.
        Sonntagsanteil), der Dienstplan wird automatisch gesetzeskonform verteilt. Bis zu zwei Fahrer pro
        Fahrzeug möglich - Tage werden dann untereinander aufgeteilt. Nettoarbeitszeit liegt immer zwischen
        5 und 8 Std./Tag; ist „Spesen berechnen" aktiv, wird zusätzlich sichergestellt, dass Netto + Pause +
        Arbeitsweg zusammen 8–10 Std. ergeben (Voraussetzung für Verpflegungsmehraufwand). Die Startzeit wird
        bewusst nicht jeden Tag gleich gewählt. Die Pausenlänge ist optional bewusst länger als das
        gesetzliche Minimum wählbar (z. B. für eine Splitschicht zwischen den Stoßzeiten) - das ArbZG legt
        nur eine Mindestpause fest, keine Höchstdauer; kürzer als das Minimum ist nie möglich.
      </p>

      <form action={formAction} className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="field">
            <label className="label">Fahrzeug</label>
            <select name="vehicleId" className="input" required>
              <option value="">– wählen –</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.licensePlate}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">Monat</label>
            <select name="month" className="input" defaultValue={defaultMonth}>
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">Jahr</label>
            <input type="number" name="year" className="input" defaultValue={defaultYear} />
          </div>
        </div>

        <DriverFields index={1} drivers={drivers} />

        <details className="mt-6 rounded-xl border border-border">
          <summary className="cursor-pointer bg-surfaceAlt px-4 py-3 text-sm font-semibold">
            Fahrer 2 (optional)
          </summary>
          <div className="p-4">
            <DriverFields index={2} drivers={drivers} />
          </div>
        </details>

        <Submit />
      </form>

      {state.error && <p className="mt-4 text-sm text-danger">{state.error}</p>}
      {state.warnings.length > 0 && (
        <div className="mt-4 space-y-1">
          {state.warnings.map((w, i) => <p key={i} className="text-sm text-accent">{w}</p>)}
        </div>
      )}

      {state.shifts.length > 0 && (
        <>
          <form action={applyHoursPlanning} className="mt-4 flex flex-wrap items-start justify-end gap-3">
            <input type="hidden" name="vehicleId" value={state.vehicleId} />
            <input type="hidden" name="shiftsJson" value={JSON.stringify(state.shifts)} />
            <ApplySubmit />
            <PdfExportPanel rows={state.shifts} />
          </form>

          <div className="mt-6">
            <Badge tone="success">{state.shifts.filter((s) => !s.isFree).length} Schichten erzeugt</Badge>

            {Array.from(new Set(state.shifts.map((s) => s.driverName))).map((name) => {
            const { totalNet, night25, night40, sunday50 } = computeSurcharges(state.shifts.filter((s) => s.driverName === name))
            const { freeDays, spesenDays, spesenAmount, grossWage, hourlyRate } = computeExtendedStats(state.shifts.filter((s) => s.driverName === name))
            return (
              <div key={name} className="mt-4 rounded-lg border border-border p-3 text-sm">
                <p className="mb-2 font-semibold">{name} – Monatszusammenfassung</p>
                <div className="grid grid-cols-4 gap-3 text-xs">
                  <div><span className="text-textMuted">Gesamt</span><br /><span className="font-mono text-sm">{totalNet.toFixed(2)} h</span></div>
                  <div><span className="text-textMuted">Nachtzuschlag 25 %</span><br /><span className="font-mono text-sm">{night25.toFixed(2)} h</span></div>
                  <div><span className="text-textMuted">Nachtzuschlag 40 % steuerfrei</span><br /><span className="font-mono text-sm">{night40.toFixed(2)} h</span></div>
                  <div><span className="text-textMuted">Sonntagszuschlag 50 %</span><br /><span className="font-mono text-sm">{sunday50.toFixed(2)} h</span></div>
                  <div><span className="text-textMuted">Freie Tage</span><br /><span className="font-mono text-sm">{freeDays}</span></div>
                  <div><span className="text-textMuted">Spesen-Tage</span><br /><span className="font-mono text-sm">{spesenDays}</span></div>
                  <div><span className="text-textMuted">Spesen gesamt (14 €/Tag)</span><br /><span className="font-mono text-sm">{spesenAmount.toFixed(2)} €</span></div>
                  <div>
                    <span className="text-textMuted">Lohn brutto (geschätzt)</span><br />
                    <span className="font-mono text-sm">{grossWage != null ? `${grossWage.toFixed(2)} €` : '– kein Stundenlohn hinterlegt –'}</span>
                  </div>
                </div>
                {hourlyRate != null && (
                  <p className="mt-2 text-[10px] text-textMuted">
                    Bruttolohn geschätzt aus {totalNet.toFixed(2)} Std. × {hourlyRate.toFixed(2)} €/Std., zzgl. Sonntagszuschlag 50 % - Nachtzuschläge (steuerfrei) und Spesen sind hier nicht enthalten.
                  </p>
                )}
              </div>
            )
          })}

          {Array.from(new Set(state.shifts.map((s) => s.driverName))).length > 1 && (() => {
            const combined = computeSurcharges(state.shifts)
            return (
              <div className="mt-4 rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
                <p className="mb-2 font-semibold">Gesamt (beide Fahrer zusammen)</p>
                <div className="grid grid-cols-4 gap-3 text-xs">
                  <div><span className="text-textMuted">Gesamt</span><br /><span className="font-mono text-sm">{combined.totalNet.toFixed(2)} h</span></div>
                  <div><span className="text-textMuted">Nachtzuschlag 25 %</span><br /><span className="font-mono text-sm">{combined.night25.toFixed(2)} h</span></div>
                  <div><span className="text-textMuted">Nachtzuschlag 40 % steuerfrei</span><br /><span className="font-mono text-sm">{combined.night40.toFixed(2)} h</span></div>
                  <div><span className="text-textMuted">Sonntagszuschlag 50 %</span><br /><span className="font-mono text-sm">{combined.sunday50.toFixed(2)} h</span></div>
                </div>
              </div>
            )
          })()}

          <table className="mt-6 w-full text-sm">
            <thead className="text-left text-xs uppercase text-textMuted">
              <tr>
                <th className="pb-2">Fahrer</th><th className="pb-2">Datum</th><th className="pb-2">Von</th>
                <th className="pb-2">Bis</th><th className="pb-2">Pause</th><th className="pb-2">Weg</th>
                <th className="pb-2">Netto</th><th className="pb-2">Gesamt</th>
                <th className="pb-2">Nacht 25%</th><th className="pb-2">Nacht 40%</th><th className="pb-2">Sonntag 50%</th>
              </tr>
            </thead>
            <tbody>
              {state.shifts.map((s, i) => {
                if (s.isFree) {
                  return (
                    <tr key={i} className="border-t border-border text-textMuted">
                      <td className="py-2 font-medium">{s.driverName}</td>
                      <td className="py-2 font-mono">
                        {s.isSunday && '☀️ '}{fmtDateDEWithWeekday(s.date)}
                      </td>
                      <td className="py-2 italic" colSpan={9}>frei</td>
                    </tr>
                  )
                }
                const totalHours = (s.netHours ?? 0) + (s.breakMinutes ?? 0) / 60 + (s.commuteMinutes ?? 0) / 60
                const day = computeSurcharges([s])
                const fmtHrs = (h: number) => (h > 0.005 ? h.toFixed(2) + ' h' : '–')
                return (
                  <tr key={i} className="border-t border-border">
                    <td className="py-2 font-medium">{s.driverName}</td>
                    <td className="py-2 font-mono">
                      {s.isSunday && '☀️ '}{s.isNightShift && '🌙 '}{fmtDateDEWithWeekday(s.date)}
                    </td>
                    <td className="py-2 font-mono">{minToClock(s.startMin!)}</td>
                    <td className="py-2 font-mono">{minToClock(s.endMin!)}</td>
                    <td className="py-2 font-mono">{formatBreakRanges(s.startMin!, s.breaks!)}</td>
                    <td className="py-2 font-mono">{s.commuteMinutes} min</td>
                    <td className="py-2 font-mono">{(s.netHours ?? 0).toFixed(2)} h</td>
                    <td className="py-2 font-mono">{totalHours.toFixed(2)} h</td>
                    <td className="py-2 font-mono">{fmtHrs(day.night25)}</td>
                    <td className="py-2 font-mono">{fmtHrs(day.night40)}</td>
                    <td className="py-2 font-mono">{fmtHrs(day.sunday50)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </>
      )}
    </Card>
  )
}
