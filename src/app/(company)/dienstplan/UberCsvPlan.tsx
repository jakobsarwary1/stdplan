'use client'

import { useState } from 'react'

type Row = {
  tag: string
  von: string
  bis: string
  pauseMin: number | null
  bezahlt: number | null
  ruhe: number | null
  nacht25: number | null
  nacht40: number | null
  sonntag: number | null
  feiertag: number | null
  hinweis: string
}
type Driver = {
  name: string
  paidH: number
  workDays: number
  freeDays: number
  ruheTage: number
  violations: number
  weekNotes: string[]
  rows: Row[]
}

const n2 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pauseH = (min: number) => `${(min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 })} h`

export default function UberCsvPlan() {
  const [csv, setCsv] = useState<string | null>(null)
  const [datei, setDatei] = useState('')
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [month, setMonth] = useState('')
  const [drivers, setDrivers] = useState<Driver[] | null>(null)
  const [aktiv, setAktiv] = useState('')

  async function laden(file: File) {
    setBusy(true)
    setFehler(null)
    try {
      const text = await file.text()
      const res = await fetch('/api/dienstplan/aus-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Die Datei ließ sich nicht auswerten.')
      setCsv(text)
      setDatei(file.name)
      setMonth(j.monthLabel || j.month || '')
      const list = (j.drivers as Driver[]) ?? []
      setDrivers(list)
      setAktiv(list[0]?.name ?? '')
    } catch (err) {
      setDrivers(null)
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function xlsx() {
    if (!csv) return
    setBusy(true)
    setFehler(null)
    try {
      const res = await fetch('/api/dienstplan/aus-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, format: 'xlsx' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || 'Excel ließ sich nicht erzeugen.')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Stundenzettel_${(month || 'Monat').replace(/\s+/g, '_')}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function csvDownload() {
    if (!csv) return
    setBusy(true)
    setFehler(null)
    try {
      const res = await fetch('/api/dienstplan/aus-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, format: 'csv' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || 'CSV ließ sich nicht erzeugen.')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Stundenzettel_${(month || 'Monat').replace(/\s+/g, '_')}_alle-Fahrer.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function mappe() {
    if (!csv) return
    setBusy(true)
    setFehler(null)
    try {
      const res = await fetch('/api/dienstplan/aus-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, format: 'mappe' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || 'Arbeitsmappe ließ sich nicht erzeugen.')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Stundenzettel_${(month || 'Monat').replace(/\s+/g, '_')}_je-Fahrer.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const fahrer = drivers?.find((d) => d.name === aktiv) ?? drivers?.[0]

  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Monatsplan aus der Uber- oder Fahrlygo-Fahrtliste</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-textMuted">
            CSV hier ablegen – Uber („trip_activity") oder Fahrlygo („rides-archive"), der Anbieter wird
            automatisch erkannt. Daraus entsteht der Stundenzettel wie gewohnt:
            je Fahrer der ganze Monat mit Von, Bis, Pause in Minuten, bezahlten Stunden und Zuschlägen.
            Eine Schicht endet nach höchstens 10 Stunden, die nächste beginnt frühestens nach 11 Stunden.
          </p>
        </div>
        <label className="inline-flex cursor-pointer items-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-bg">
          {busy ? 'Lese…' : 'CSV auswählen'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void laden(file)
              e.target.value = ''
            }}
          />
        </label>
      </div>
      {datei && <p className="mt-2 text-xs text-textMuted">{datei}</p>}
      {fehler && <p className="mt-3 text-sm text-danger">{fehler}</p>}

      {drivers && fahrer && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {drivers.map((d) => (
              <button
                key={d.name}
                type="button"
                onClick={() => setAktiv(d.name)}
                className={`rounded-lg px-3 py-1.5 text-sm ${d.name === fahrer.name ? 'bg-accent text-bg' : 'border border-border text-textMuted'}`}
              >
                {d.name}
              </button>
            ))}
            <button type="button" onClick={() => void mappe()} disabled={busy} className="ml-auto rounded-lg border border-[var(--accent,#c79a3a)] px-3 py-1.5 text-sm font-medium">
              Arbeitsmappe (je Fahrer ein Blatt)
            </button>
            <button type="button" onClick={() => void csvDownload()} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium">
              CSV (alle Fahrer)
            </button>
            <button type="button" onClick={() => void xlsx()} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium">
              Excel (Formular)
            </button>
          </div>
          <p className="text-sm text-textMuted">
            {n2(fahrer.paidH)} bezahlte Stunden · {fahrer.workDays} Arbeitstage · {fahrer.freeDays} frei
            {fahrer.ruheTage > 0 && ` · ${fahrer.ruheTage} als Ruhetag gesetzt`}
            {fahrer.violations > 0 && ` · ${fahrer.violations} Hinweise`}
          </p>
          {fahrer.weekNotes.length > 0 && (
            <ul className="space-y-1 text-xs text-textMuted">
              {fahrer.weekNotes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
          <div className="overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-textMuted">
                <tr>
                  <th className="px-3 py-2">Datum</th>
                  <th className="px-3 py-2">Von</th>
                  <th className="px-3 py-2">Bis</th>
                  <th className="px-3 py-2">Pause</th>
                  <th className="px-3 py-2">Bezahlt (Std.)</th>
                  <th className="px-3 py-2">Ruhezeit (Std.)</th>
                  <th className="px-3 py-2">Nacht 25%</th>
                  <th className="px-3 py-2">Nacht 40%</th>
                  <th className="px-3 py-2">Sonntag 50%</th>
                  <th className="px-3 py-2">Hinweis</th>
                </tr>
              </thead>
              <tbody>
                {fahrer.rows.map((d, i) => (
                  <tr key={`${d.tag}-${i}`} className="border-t border-border/70">
                    <td className="whitespace-nowrap px-3 py-1.5">{d.tag}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.von}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.bis}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.pauseMin == null ? '' : pauseH(d.pauseMin)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.bezahlt == null ? '' : n2(d.bezahlt)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.ruhe == null ? '' : n2(d.ruhe)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.nacht25 == null ? '' : n2(d.nacht25)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.nacht40 == null ? '' : n2(d.nacht40)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.sonntag == null ? '' : n2(d.sonntag)}</td>
                    <td className="px-3 py-1.5 text-xs text-textMuted">{d.hinweis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
