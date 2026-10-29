'use client'

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

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
  nettoH: number
  workDays: number
  freeDays: number
  ruheTage: number
  violations: number
  weekNotes: string[]
  rows: Row[]
}

const n2 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pauseH = (min: number) => `${(min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 })} h`
const num = (s: string): number => {
  const n = parseFloat((s || '').replace(',', '.').replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

type Ziel = { gesamt: string; sonntag: string; nacht25: string; nacht40: string; feiertag: string }
type ZielZahl = { gesamt: number; sonntag: number; nacht25: number; nacht40: number; feiertag: number }

export default function UberCsvPlan() {
  const [csv, setCsv] = useState<string | null>(null)
  const [datei, setDatei] = useState('')
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [month, setMonth] = useState('')
  const [drivers, setDrivers] = useState<Driver[] | null>(null)
  const [aktiv, setAktiv] = useState('')
  const [ziele, setZiele] = useState<Record<string, Ziel>>({})
  const [dupePairs, setDupePairs] = useState<string[][]>([])
  const [merges, setMerges] = useState<string[][]>([])
  const [exakt, setExakt] = useState(true)
  const [raster, setRaster] = useState(15) // Zeit-Raster in Minuten: 15 / 10 / 1 (punktgenau)

  /** Nur gesetzte Ziele (Gesamt > 0) als Zahlen – für die Anfrage an die Route. */
  function zieleBody(): Record<string, ZielZahl> {
    const out: Record<string, ZielZahl> = {}
    for (const [name, z] of Object.entries(ziele)) {
      const g = num(z.gesamt)
      if (g > 0) out[name] = { gesamt: g, sonntag: num(z.sonntag), nacht25: num(z.nacht25), nacht40: num(z.nacht40), feiertag: num(z.feiertag) }
    }
    return out
  }

  const setZiel = (name: string, feld: keyof Ziel, wert: string) =>
    setZiele((z) => {
      const cur: Ziel = z[name] ?? { gesamt: '', sonntag: '', nacht25: '', nacht40: '', feiertag: '' }
      return { ...z, [name]: { ...cur, [feld]: wert } }
    })

  /** Vorschau mit den aktuellen Zielvorgaben/Merges neu berechnen (ohne Datei-Reupload). */
  async function neuBerechnen(mergesArg: string[][] = merges, zieleArg?: Record<string, ZielZahl>) {
    if (!csv) return
    setBusy(true)
    setFehler(null)
    try {
      const res = await fetch('/api/dienstplan/aus-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, ziele: zieleArg ?? zieleBody(), merges: mergesArg, exakt, raster }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Neuberechnung fehlgeschlagen.')
      setDrivers((j.drivers as Driver[]) ?? [])
      setDupePairs((j.dupePairs as string[][]) ?? [])
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function laden(file: File) {
    setBusy(true)
    setFehler(null)
    try {
      const text = await file.text()
      const res = await fetch('/api/dienstplan/aus-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text, ziele: zieleBody(), merges, exakt, raster }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Die Datei ließ sich nicht auswerten.')
      setCsv(text)
      setDatei(file.name)
      setMonth(j.monthLabel || j.month || '')
      const list = (j.drivers as Driver[]) ?? []
      setDrivers(list)
      setDupePairs((j.dupePairs as string[][]) ?? [])
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
        body: JSON.stringify({ csv, format: 'xlsx', ziele: zieleBody(), merges, exakt, raster }),
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
        body: JSON.stringify({ csv, format: 'csv', ziele: zieleBody(), merges, exakt, raster }),
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
        body: JSON.stringify({ csv, format: 'mappe', ziele: zieleBody(), merges, exakt, raster }),
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
  // Fahrerliste für die manuelle Stunden-Tabelle: CSV-Fahrer + evtl. zusätzliche
  // Ziel-Fahrer (eigene Zettel). Ohne PDF einfach die Zahlen eintippen.
  // Aktuelle Fahrerliste (nach Zusammenführungen) für Tabelle und Zuordnung.
  const aktuelleFahrer = drivers?.map((d) => d.name) ?? []
  const alleFahrer = [...aktuelleFahrer, ...Object.keys(ziele).filter((n) => !aktuelleFahrer.includes(n))]

  // Tastatur-Navigation in der Stunden-Tabelle (wie Excel): ↑/↓ & Enter wechseln
  // die Zeile, ←/→ am Feldrand die Spalte. 5 Spalten (Gesamt … Feiertag).
  const fokusZelle = (ri: number, ci: number) => {
    const el = document.getElementById(`z-${ri}-${ci}`) as HTMLInputElement | null
    if (el) { el.focus(); el.select() }
  }
  const zellenTaste = (e: ReactKeyboardEvent<HTMLInputElement>, ri: number, ci: number) => {
    const zeilen = alleFahrer.length
    const t = e.currentTarget
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); fokusZelle(Math.min(zeilen - 1, ri + 1), ci) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); fokusZelle(Math.max(0, ri - 1), ci) }
    else if (e.key === 'ArrowRight' && t.selectionStart === t.value.length && t.selectionEnd === t.value.length) { e.preventDefault(); fokusZelle(ri, Math.min(4, ci + 1)) }
    else if (e.key === 'ArrowLeft' && t.selectionStart === 0 && t.selectionEnd === 0) { e.preventDefault(); fokusZelle(ri, Math.max(0, ci - 1)) }
  }

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

      {dupePairs.length > 0 && (
        <div className="mt-3 space-y-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-200">
          <div className="font-medium">⚠ Mögliche Doppel-Fahrer</div>
          {dupePairs.map((pair) => (
            <div key={pair.join('|')} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>„{pair[0]}" und „{pair[1]}" – nicht automatisch zusammengeführt.</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => { const neu = [...merges, pair]; setMerges(neu); void neuBerechnen(neu) }}
                className="rounded-lg border border-amber-400/60 bg-amber-400/20 px-3 py-1 font-medium text-amber-100 hover:bg-amber-400/30 disabled:opacity-50"
              >
                Zusammenführen
              </button>
            </div>
          ))}
        </div>
      )}
      {merges.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-textMuted">
          {merges.length} Zusammenführung(en) aktiv.
          <button type="button" disabled={busy} onClick={() => { setMerges([]); void neuBerechnen([]) }}
            className="underline hover:text-text">rückgängig</button>
        </p>
      )}

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
            {n2(fahrer.nettoH)} bezahlte Stunden (Arbeitszeit ohne Pause) · {n2(fahrer.paidH)} brutto · {fahrer.workDays} Arbeitstage · {fahrer.freeDays} frei
            {fahrer.ruheTage > 0 && ` · ${fahrer.ruheTage} als Ruhetag gesetzt`}
            {fahrer.violations > 0 && ` · ${fahrer.violations} Hinweise`}
          </p>

          {/* Stunden je Fahrer direkt eintippen – aus der Lohnabrechnung. */}
          <div className="space-y-2 rounded-xl border border-border bg-bg/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs">
                <span className="font-medium text-text">Stunden je Fahrer eintippen (aus der Lohnabrechnung)</span>
                <span className="text-textMuted"> — kein PDF nötig. Leer = dieser Fahrer wird übersprungen. Navigation mit ↑ ↓ Enter ← → wie in Excel.</span>
              </div>
              <button type="button" onClick={() => void neuBerechnen()} disabled={busy}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50">
                {busy ? 'Rechne…' : 'Stundenzettel erstellen'}
              </button>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-textMuted">
                    <th className="px-2 py-1 font-medium">Fahrer</th>
                    <th className="px-2 py-1 text-right font-medium">Gesamt</th>
                    <th className="px-2 py-1 text-right font-medium">Sonntag</th>
                    <th className="px-2 py-1 text-right font-medium">Nacht 25 %</th>
                    <th className="px-2 py-1 text-right font-medium">Nacht 40 %</th>
                    <th className="px-2 py-1 text-right font-medium">Feiertag</th>
                  </tr>
                </thead>
                <tbody>
                  {alleFahrer.map((name, ri) => {
                    const ist = drivers?.find((d) => d.name === name)
                    const g = num(ziele[name]?.gesamt ?? '')
                    const treffer = g > 0 && ist && Math.abs(ist.nettoH - g) < 0.05
                    return (
                      <tr key={name} className="border-t border-border/60">
                        <td className="whitespace-nowrap px-2 py-1">
                          {name}{treffer && <span className="ml-1 text-accent">✓</span>}
                        </td>
                        {(['gesamt', 'sonntag', 'nacht25', 'nacht40', 'feiertag'] as (keyof Ziel)[]).map((feld, ci) => (
                          <td key={feld} className="px-1 py-0.5">
                            <input id={`z-${ri}-${ci}`} inputMode="decimal" placeholder="0"
                              value={ziele[name]?.[feld] ?? ''}
                              onChange={(e) => setZiel(name, feld, e.target.value)}
                              onKeyDown={(e) => zellenTaste(e, ri, ci)}
                              className="w-20 rounded-lg border border-border bg-bg px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-accent" />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex items-center gap-2 text-xs text-textMuted">
                <input type="checkbox" checked={exakt} onChange={(e) => { setExakt(e.target.checked) }} className="h-3.5 w-3.5 accent-accent" />
                <span><span className="font-medium text-text">Genau treffen</span> (freie Uhrzeiten) – alle Vorgaben exakt, 11 h Ruhe &amp; max. 6 Tage.</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-textMuted">
                <span className="font-medium text-text">Zeit-Raster</span>
                <select value={raster} onChange={(e) => setRaster(Number(e.target.value))}
                  className="rounded-lg border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent">
                  <option value={15}>15 Minuten (sauber)</option>
                  <option value={10}>10 Minuten</option>
                  <option value={1}>punktgenau</option>
                </select>
              </label>
            </div>
          </div>

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
