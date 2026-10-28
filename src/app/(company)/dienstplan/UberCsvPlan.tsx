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
type LohnErgebnis = {
  filename: string
  name: string
  fahrer: string | null
  nichtInCsv?: boolean
  month: string | null
  gesamt: number; sonntag: number; nacht25: number; nacht40: number; feiertag: number
  krank: number; urlaub: number
  warnungen: string[]
}

const IGNORE = '' // Zuordnungswert „ignorieren"
const EIGEN = '__eigen__' // Zuordnungswert „eigener Stundenzettel (Abrechnungsname)"

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
  const [lohnInfo, setLohnInfo] = useState<LohnErgebnis[] | null>(null)
  // Fahrernamen aus der CSV (für die manuelle Zuordnung – fest ab CSV-Load).
  const [csvFahrer, setCsvFahrer] = useState<string[]>([])
  // Zuordnung je Lohnabrechnung (Dateiname → Zielfahrer/EIGEN/IGNORE).
  const [zuordnung, setZuordnung] = useState<Record<string, string>>({})

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
        body: JSON.stringify({ csv, ziele: zieleArg ?? zieleBody(), merges: mergesArg, exakt }),
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
        body: JSON.stringify({ csv: text, ziele: zieleBody(), merges, exakt }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Die Datei ließ sich nicht auswerten.')
      setCsv(text)
      setDatei(file.name)
      setMonth(j.monthLabel || j.month || '')
      const list = (j.drivers as Driver[]) ?? []
      setDrivers(list)
      setCsvFahrer(list.map((d) => d.name))
      setLohnInfo(null)
      setZuordnung({})
      setDupePairs((j.dupePairs as string[][]) ?? [])
      setAktiv(list[0]?.name ?? '')
    } catch (err) {
      setDrivers(null)
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Datei → Base64 (ohne data:-Präfix). */
  function alsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
      r.onerror = () => reject(new Error('Datei nicht lesbar.'))
      r.readAsDataURL(file)
    })
  }

  /** Zielfahrer, zu dem eine Abrechnung laut aktueller Zuordnung gehört (oder ''). */
  function zielFahrer(e: LohnErgebnis, zu: Record<string, string>): string {
    const wahl = zu[e.filename]
    if (wahl === IGNORE) return ''
    if (wahl === EIGEN) return e.name || e.fahrer || ''
    if (wahl != null) return wahl // konkreter CSV-Fahrer
    return e.fahrer ?? '' // Default: automatische Zuordnung
  }

  /** Numerische Ziele aus allen Abrechnungen + Zuordnung (mehrere je Fahrer = Summe). */
  function zieleAusLohn(info: LohnErgebnis[], zu: Record<string, string>): Record<string, ZielZahl> {
    const out: Record<string, ZielZahl> = {}
    for (const e of info) {
      if (e.gesamt <= 0) continue
      const ziel = zielFahrer(e, zu)
      if (!ziel) continue
      const c = out[ziel] ?? { gesamt: 0, sonntag: 0, nacht25: 0, nacht40: 0, feiertag: 0 }
      out[ziel] = {
        gesamt: c.gesamt + e.gesamt, sonntag: c.sonntag + e.sonntag,
        nacht25: c.nacht25 + e.nacht25, nacht40: c.nacht40 + e.nacht40, feiertag: c.feiertag + e.feiertag,
      }
    }
    return out
  }

  /** Eingabefelder auf GENAU die Lohn-Ziele setzen (alte Lohn-Ziele fallen weg). */
  function fuelleZiele(num: Record<string, ZielZahl>) {
    const next: Record<string, Ziel> = {}
    for (const [name, v] of Object.entries(num)) {
      next[name] = {
        gesamt: String(round2(v.gesamt)), sonntag: v.sonntag ? String(round2(v.sonntag)) : '',
        nacht25: v.nacht25 ? String(round2(v.nacht25)) : '', nacht40: v.nacht40 ? String(round2(v.nacht40)) : '',
        feiertag: v.feiertag ? String(round2(v.feiertag)) : '',
      }
    }
    setZiele(next)
  }

  /** Lohnabrechnungen (PDF) einlesen → automatische Zuordnung + Zielwerte füllen. */
  async function lohnLaden(files: File[]) {
    if (!csv || !drivers || files.length === 0) return
    setBusy(true)
    setFehler(null)
    try {
      const pdfs = await Promise.all(files.map(async (f) => ({ filename: f.name, dataBase64: await alsBase64(f) })))
      const res = await fetch('/api/dienstplan/lohn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfs, driverNames: drivers.map((d) => d.name) }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Die Lohnabrechnungen ließen sich nicht lesen.')
      const info = (j.ergebnisse as LohnErgebnis[]) ?? []
      // Standard-Zuordnung je Abrechnung: automatisch erkannter Fahrer, sonst
      // „eigener Stundenzettel" (Lohn ohne CSV-Fahrt) bzw. „ignorieren" (0 h).
      const zu: Record<string, string> = {}
      for (const e of info) {
        zu[e.filename] = e.gesamt <= 0 ? IGNORE : e.nichtInCsv ? EIGEN : (e.fahrer ?? EIGEN)
      }
      setLohnInfo(info)
      setZuordnung(zu)
      const num = zieleAusLohn(info, zu)
      fuelleZiele(num)
      await neuBerechnen(merges, num)
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Eine Abrechnung manuell einem Fahrer zuordnen und sofort neu rechnen. */
  async function setzeZuordnung(filename: string, wert: string) {
    if (!lohnInfo) return
    const zu = { ...zuordnung, [filename]: wert }
    setZuordnung(zu)
    const num = zieleAusLohn(lohnInfo, zu)
    fuelleZiele(num)
    await neuBerechnen(merges, num)
  }

  async function xlsx() {
    if (!csv) return
    setBusy(true)
    setFehler(null)
    try {
      const res = await fetch('/api/dienstplan/aus-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, format: 'xlsx', ziele: zieleBody(), merges, exakt }),
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
        body: JSON.stringify({ csv, format: 'csv', ziele: zieleBody(), merges, exakt }),
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
        body: JSON.stringify({ csv, format: 'mappe', ziele: zieleBody(), merges, exakt }),
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
  const tabFahrer = csvFahrer.length ? csvFahrer : (drivers?.map((d) => d.name) ?? [])
  const alleFahrer = [...tabFahrer, ...Object.keys(ziele).filter((n) => !tabFahrer.includes(n))]

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
            <label className="ml-auto inline-flex cursor-pointer items-center rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg">
              {busy ? 'Lese…' : 'Lohnabrechnungen (PDF) einlesen'}
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  if (files.length) void lohnLaden(files)
                  e.target.value = ''
                }}
              />
            </label>
            <button type="button" onClick={() => void mappe()} disabled={busy} className="rounded-lg border border-[var(--accent,#c79a3a)] px-3 py-1.5 text-sm font-medium">
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

          {lohnInfo && lohnInfo.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-border bg-bg/40 p-3 text-xs">
              <div className="mb-1 font-medium text-text">Aus Lohnabrechnungen eingelesen ({lohnInfo.length}) · Zuordnung änderbar</div>
              {lohnInfo.map((e) => {
                const wahl = zuordnung[e.filename] ?? (e.gesamt <= 0 ? IGNORE : e.nichtInCsv ? EIGEN : (e.fahrer ?? EIGEN))
                const zugeordnet = wahl !== IGNORE
                return (
                  <div key={e.filename} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-textMuted/70">{e.name || e.filename}</span>
                    {e.gesamt > 0 && <span className="text-textMuted">Gesamt {n2(e.gesamt)}</span>}
                    {e.sonntag > 0 && <span className="text-textMuted">So {n2(e.sonntag)}</span>}
                    {e.nacht25 > 0 && <span className="text-textMuted">N25 {n2(e.nacht25)}</span>}
                    {e.nacht40 > 0 && <span className="text-textMuted">N40 {n2(e.nacht40)}</span>}
                    {e.feiertag > 0 && <span className="text-textMuted">Fe {n2(e.feiertag)}</span>}
                    {e.krank > 0 && <span className="text-textMuted/70">Krank {n2(e.krank)}</span>}
                    {e.urlaub > 0 && <span className="text-textMuted/70">Urlaub {n2(e.urlaub)}</span>}
                    <span className="ml-auto flex items-center gap-1">
                      <span className={zugeordnet ? 'text-textMuted/70' : 'text-amber-300'}>→</span>
                      <select
                        value={wahl}
                        disabled={busy || e.gesamt <= 0}
                        onChange={(ev) => void setzeZuordnung(e.filename, ev.target.value)}
                        className="max-w-[16rem] rounded-lg border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
                      >
                        <option value={IGNORE}>— ignorieren —</option>
                        {e.gesamt > 0 && <option value={EIGEN}>Eigener Zettel: {e.name || e.filename}</option>}
                        {csvFahrer.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </span>
                    {e.warnungen.filter((w) => !/eigener Stundenzettel|manuell zuordnen/i.test(w)).map((w, i) => (
                      <span key={i} className="w-full text-amber-300/80">· {w}</span>
                    ))}
                  </div>
                )
              })}
              <div className="pt-1 text-textMuted/80">
                Nicht erkannte Fahrer rechts zuordnen (z. B. anderer Name in der CSV) oder „Eigener Zettel" lassen. Krank/Urlaub sind nur zur Info, keine geplanten Schichten.
              </div>
            </div>
          )}

          {/* Stunden je Fahrer direkt eintippen (ohne PDF) – die zuverlässige
              Alternative zum Einlesen der Lohnabrechnungen. */}
          <div className="space-y-2 rounded-xl border border-border bg-bg/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs">
                <span className="font-medium text-text">Stunden je Fahrer eintippen (aus der Lohnabrechnung)</span>
                <span className="text-textMuted"> — kein PDF nötig. Leer = dieser Fahrer wird übersprungen.</span>
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
                  {alleFahrer.map((name) => {
                    const ist = drivers?.find((d) => d.name === name)
                    const g = num(ziele[name]?.gesamt ?? '')
                    const treffer = g > 0 && ist && Math.abs(ist.nettoH - g) < 0.05
                    return (
                      <tr key={name} className="border-t border-border/60">
                        <td className="whitespace-nowrap px-2 py-1">
                          {name}{treffer && <span className="ml-1 text-accent">✓</span>}
                        </td>
                        {(['gesamt', 'sonntag', 'nacht25', 'nacht40', 'feiertag'] as (keyof Ziel)[]).map((feld) => (
                          <td key={feld} className="px-1 py-0.5">
                            <input inputMode="decimal" placeholder="0"
                              value={ziele[name]?.[feld] ?? ''}
                              onChange={(e) => setZiel(name, feld, e.target.value)}
                              className="w-20 rounded-lg border border-border bg-bg px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-accent" />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <label className="flex items-center gap-2 text-xs text-textMuted">
              <input type="checkbox" checked={exakt} onChange={(e) => { setExakt(e.target.checked) }} className="h-3.5 w-3.5 accent-accent" />
              <span><span className="font-medium text-text">Genau treffen</span> (freie Uhrzeiten) – alle Vorgaben exakt, 11 h Ruhe &amp; max. 6 Tage. Aus: so nah wie möglich an den echten Uber-Zeiten.</span>
            </label>
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
