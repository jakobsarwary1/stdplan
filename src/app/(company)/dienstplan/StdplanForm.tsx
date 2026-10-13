'use client'

import { useEffect, useMemo, useState } from 'react'

type Driver = { id: string; name: string; employeeNumber: string; rate: number }

/** Eingabewerte je Fahrer für den Monat. Alles optional – leer = 0 / kein Text. */
type Entry = {
  rate: string
  total: string
  sunday: string
  night25: string
  night40: string
  krank: string
  brutto: string
  abmelden: string
}

const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
]

const leer = (rate: number): Entry => ({
  rate: rate ? String(rate).replace('.', ',') : '',
  total: '', sunday: '', night25: '', night40: '', krank: '', brutto: '', abmelden: '',
})

const num = (s: string): number => {
  const n = parseFloat((s || '').replace(',', '.').replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function StdplanForm({ drivers, companyName }: { drivers: Driver[]; companyName: string }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1) // 1-12
  const [data, setData] = useState<Record<string, Entry>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [suche, setSuche] = useState('')
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)

  const storageKey = `stdplan:v1:${year}-${String(month).padStart(2, '0')}`

  // Beim Monatswechsel: gespeicherte Eingaben laden, sonst mit Stundenlohn vorbelegen.
  useEffect(() => {
    let geladen: Record<string, Entry> = {}
    try {
      const roh = localStorage.getItem(storageKey)
      if (roh) geladen = JSON.parse(roh)
    } catch { /* ignore */ }
    const next: Record<string, Entry> = {}
    for (const d of drivers) next[d.id] = geladen[d.id] ?? leer(d.rate)
    setData(next)
  }, [storageKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-Speichern im Browser (geht bei versehentlichem Neuladen nicht verloren).
  useEffect(() => {
    if (Object.keys(data).length === 0) return
    try { localStorage.setItem(storageKey, JSON.stringify(data)) } catch { /* ignore */ }
  }, [data, storageKey])

  const set = (id: string, feld: keyof Entry, wert: string) =>
    setData((d) => ({ ...d, [id]: { ...d[id], [feld]: wert } }))

  const monthLabel = `${MONATE[month - 1]} ${year}`

  const berechnet = useMemo(() => drivers.map((d, i) => {
    const e = data[d.id] ?? leer(d.rate)
    const rate = num(e.rate)
    const total = num(e.total)
    const sunday = num(e.sunday)
    const n25 = num(e.night25)
    const n40 = num(e.night40)
    const gesamt = total * rate + sunday * rate * 0.5 + n25 * rate * 0.25 + n40 * rate * 0.4
    const extras = (e.krank || e.brutto || e.abmelden || sunday || n25 || n40) ? true : false
    return { sn: i + 1, d, e, rate, total, gesamt, gefuellt: total > 0, extras }
  }), [drivers, data])

  const sichtbar = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return q ? berechnet.filter((r) => r.d.name.toLowerCase().includes(q)) : berechnet
  }, [berechnet, suche])

  const ausgefuellt = berechnet.filter((r) => r.gefuellt).length
  const summe = berechnet.reduce((s, r) => s + r.gesamt, 0)
  const fortschritt = drivers.length ? Math.round((ausgefuellt / drivers.length) * 100) : 0

  async function erzeugen() {
    setBusy(true); setFehler(null)
    try {
      const rows = berechnet.map((r) => ({
        sn: r.sn, name: r.d.name, employeeNumber: r.d.employeeNumber, rate: r.rate,
        total: num(r.e.total), sunday: num(r.e.sunday), night25: num(r.e.night25), night40: num(r.e.night40),
        krank: r.e.krank, brutto: r.e.brutto, abmelden: r.e.abmelden,
      }))
      const res = await fetch('/api/dienstplan/xlsx', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, monthLabel, companyName, rows }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Fehler beim Erzeugen')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Stundenzettel_${monthLabel.replace(' ', '_')}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const feld = 'w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-text outline-none transition-colors focus:border-accent'
  const zahl = feld + ' text-right tabular-nums'

  return (
    <div className="space-y-5">
      {/* Kopfzeile */}
      <div className="sticky top-0 z-10 -mx-6 border-b border-border bg-bg/85 px-6 py-4 backdrop-blur">
        <div className="mx-auto max-w-5xl space-y-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Dienstplan erstellen</h1>
            <p className="text-sm text-textMuted">
              Monat wählen, je Fahrer Stunden eintragen → vollständiger Stundenzettel (Excel mit Formeln).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Monat/Jahr */}
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface p-1">
              <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
                className="rounded-lg bg-transparent px-2 py-1.5 text-sm outline-none">
                {MONATE.map((m, i) => <option key={i} value={i + 1} className="bg-surface">{m}</option>)}
              </select>
              <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                className="rounded-lg bg-transparent px-2 py-1.5 text-sm outline-none">
                {[now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => (
                  <option key={y} value={y} className="bg-surface">{y}</option>
                ))}
              </select>
            </div>

            {/* Suche */}
            <div className="relative min-w-[12rem] flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textMuted">⌕</span>
              <input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Fahrer suchen…"
                className="w-full rounded-xl border border-border bg-surface py-2 pl-8 pr-3 text-sm outline-none transition-colors focus:border-accent" />
            </div>

            {/* Fortschritt */}
            <div className="hidden items-center gap-2 sm:flex">
              <div className="h-2 w-28 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${fortschritt}%` }} />
              </div>
              <span className="whitespace-nowrap text-xs text-textMuted">{ausgefuellt} von {drivers.length}</span>
            </div>

            {/* Gesamtlohn */}
            <div className="rounded-xl border border-border bg-surface px-3 py-1.5 text-right">
              <div className="text-[0.65rem] uppercase tracking-wide text-textMuted">Gesamtlohn (ca.)</div>
              <div className="font-semibold tabular-nums text-text">{eur(summe)} €</div>
            </div>

            <button onClick={erzeugen} disabled={busy || ausgefuellt === 0}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? 'Erzeuge…' : 'Stundenzettel erzeugen'}
            </button>
          </div>

          {fehler && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{fehler}</div>}
        </div>
      </div>

      {/* Fahrerkarten */}
      <div className="mx-auto max-w-5xl space-y-2.5">
        {drivers.length === 0 && (
          <div className="rounded-2xl border border-border bg-surface p-10 text-center text-sm text-textMuted">
            Keine aktiven Fahrer. Lege zuerst unter „Fahrer" welche an.
          </div>
        )}

        {sichtbar.map((r) => {
          const auf = !!open[r.d.id]
          return (
            <div key={r.d.id}
              className={`overflow-hidden rounded-2xl border bg-surface transition-colors ${
                r.gefuellt ? 'border-border' : 'border-border/60'
              }`}>
              {/* Kernzeile */}
              <div className={`flex flex-wrap items-center gap-3 border-l-4 px-4 py-3 ${
                r.gefuellt ? 'border-l-accent' : 'border-l-transparent'
              }`}>
                <div className="flex min-w-[11rem] flex-1 items-center gap-3">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                    r.gefuellt ? 'bg-accent/15 text-accent' : 'bg-border/60 text-textMuted'
                  }`}>{r.sn}</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-text">{r.d.name}</div>
                    {r.d.employeeNumber && <div className="text-xs text-textMuted">Pers.-Nr. {r.d.employeeNumber}</div>}
                  </div>
                </div>

                <label className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-wide text-textMuted">€/Std</span>
                  <input className={`${zahl} w-20`} inputMode="decimal" value={r.e.rate}
                    onChange={(e) => set(r.d.id, 'rate', e.target.value)} />
                </label>

                <label className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-wide text-textMuted">Gesamt Std</span>
                  <input className={`${zahl} w-24`} inputMode="decimal" value={r.e.total} placeholder="0"
                    onChange={(e) => set(r.d.id, 'total', e.target.value)} />
                </label>

                <div className="flex flex-col gap-0.5 text-right">
                  <span className="text-[0.65rem] uppercase tracking-wide text-textMuted">Lohn (ca.)</span>
                  <span className={`min-w-[6rem] font-semibold tabular-nums ${r.gefuellt ? 'text-text' : 'text-textMuted'}`}>
                    {eur(r.gesamt)} €
                  </span>
                </div>

                <button onClick={() => setOpen((o) => ({ ...o, [r.d.id]: !o[r.d.id] }))}
                  className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-textMuted transition-colors hover:border-accent hover:text-text"
                  aria-expanded={auf}>
                  Zuschläge
                  {r.extras && !auf && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  <span className={`transition-transform ${auf ? 'rotate-180' : ''}`}>⌄</span>
                </button>
              </div>

              {/* Aufklappbare Details (sanfte Höhen-Animation) */}
              <div className={`grid transition-all duration-300 ease-out ${auf ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                <div className="overflow-hidden">
                  <div className="border-t border-border bg-bg/40 px-4 py-4">
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      <Num label="Sonntag 50 % (Std)" v={r.e.sunday} on={(x) => set(r.d.id, 'sunday', x)} feld={zahl} />
                      <Num label="Nacht 25 % (Std)" v={r.e.night25} on={(x) => set(r.d.id, 'night25', x)} feld={zahl} />
                      <Num label="Nacht 40 % (Std)" v={r.e.night40} on={(x) => set(r.d.id, 'night40', x)} feld={zahl} />
                      <Txt label="Krank (Zeitraum)" v={r.e.krank} on={(x) => set(r.d.id, 'krank', x)} feld={feld} ph="z. B. 16.–20.10." />
                      <Txt label="1 % Brutto" v={r.e.brutto} on={(x) => set(r.d.id, 'brutto', x)} feld={feld} ph="Nein" />
                      <Txt label="Abmelden / Status" v={r.e.abmelden} on={(x) => set(r.d.id, 'abmelden', x)} feld={feld} ph="z. B. ab Sept. Minijob" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}

        {drivers.length > 0 && sichtbar.length === 0 && (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-textMuted">
            Kein Fahrer passt zu „{suche}".
          </div>
        )}
      </div>

      {/* Info */}
      <div className="mx-auto max-w-5xl rounded-2xl border border-border bg-surface/60 p-4 text-xs leading-relaxed text-textMuted">
        <strong className="text-text">Gesamt&nbsp;Std = bezahlte Stunden</strong> (Nettoarbeit + Pause; Pause ist bezahlt,
        Arbeitsweg zählt nie). Beim Erzeugen entsteht pro Fahrer ein tageweiser Stundenzettel für den Monat als
        <strong className="text-text"> Excel mit Formeln</strong>: Die gelben Felder (Von/Bis/Pause) sind editierbar, Netto,
        Zuschläge (§ 3b: Nacht 25/40 %, Sonntag 50 %) und Lohn rechnen sich automatisch neu. „Krank", „1 % Brutto" und
        „Abmelden" sind Textvermerke. Der Stundenlohn ist je Zeile editierbar. Eingaben werden im Browser gespeichert.
      </div>
    </div>
  )
}

function Num({ label, v, on, feld }: { label: string; v: string; on: (x: string) => void; feld: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-textMuted">{label}</span>
      <input className={feld} inputMode="decimal" value={v} placeholder="0" onChange={(e) => on(e.target.value)} />
    </label>
  )
}
function Txt({ label, v, on, feld, ph }: { label: string; v: string; on: (x: string) => void; feld: string; ph?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-textMuted">{label}</span>
      <input className={feld} value={v} placeholder={ph} onChange={(e) => on(e.target.value)} />
    </label>
  )
}
