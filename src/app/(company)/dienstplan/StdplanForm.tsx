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
  const [nurOffen, setNurOffen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)

  const storageKey = `stdplan:v1:${year}-${String(month).padStart(2, '0')}`

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
    const zuschlag = sunday > 0 || n25 > 0 || n40 > 0
    const vermerk = !!(e.krank || e.brutto || e.abmelden)
    return { sn: i + 1, d, e, rate, total, gesamt, gefuellt: total > 0, zuschlag, vermerk }
  }), [drivers, data])

  const sichtbar = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return berechnet.filter((r) =>
      (!q || r.d.name.toLowerCase().includes(q)) && (!nurOffen || !r.gefuellt)
    )
  }, [berechnet, suche, nurOffen])

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

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      {/* Titelzeile + Primäraktion */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dienstplan erstellen</h1>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-textMuted">
            Je Fahrer die bezahlten Stunden (und optional Zuschläge) eintragen – daraus entsteht ein
            tageweiser Stundenzettel als Excel mit Formeln. Eingaben werden automatisch im Browser gespeichert.
          </p>
        </div>
        <button onClick={erzeugen} disabled={busy || ausgefuellt === 0}
          className="group inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-bg shadow-lg shadow-accent/20 transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none">
          {busy
            ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-bg/40 border-t-bg" /> Erzeuge…</>
            : <><span aria-hidden>↧</span> Stundenzettel erzeugen</>}
        </button>
      </div>

      {/* Klebende Toolbar-Karte */}
      <div className="sticky top-3 z-10 rounded-2xl border border-border bg-surface/95 p-3 shadow-xl shadow-black/20 backdrop-blur sm:p-4">
        <div className="grid items-center gap-3 lg:grid-cols-[auto_1fr_auto_auto]">
          {/* Monat/Jahr als Segment */}
          <div className="flex items-center gap-1 rounded-xl border border-border bg-bg p-1">
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
              className="cursor-pointer rounded-lg bg-transparent px-2.5 py-1.5 text-sm font-medium outline-none hover:bg-surfaceAlt">
              {MONATE.map((m, i) => <option key={i} value={i + 1} className="bg-surface">{m}</option>)}
            </select>
            <span className="text-border">|</span>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}
              className="cursor-pointer rounded-lg bg-transparent px-2.5 py-1.5 text-sm font-medium outline-none hover:bg-surfaceAlt">
              {[now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => (
                <option key={y} value={y} className="bg-surface">{y}</option>
              ))}
            </select>
          </div>

          {/* Suche */}
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-textMuted">⌕</span>
            <input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Fahrer suchen…"
              className="w-full rounded-xl border border-border bg-bg py-2.5 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-textMuted/70 focus:border-accent" />
          </div>

          {/* Fortschritt */}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-bg px-3 py-2">
            <div className="h-2 w-24 overflow-hidden rounded-full bg-border sm:w-28">
              <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${fortschritt}%` }} />
            </div>
            <span className="whitespace-nowrap text-xs font-medium text-textMuted">
              <span className="text-text">{ausgefuellt}</span> / {drivers.length} erfasst
            </span>
          </div>

          {/* Gesamtlohn */}
          <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-2 text-right">
            <div className="text-[0.62rem] font-medium uppercase tracking-wider text-textMuted">Gesamtlohn (ca.)</div>
            <div className="text-lg font-semibold leading-tight tabular-nums text-text">{eur(summe)} €</div>
          </div>
        </div>

        {/* Filterzeile */}
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/70 pt-3 text-xs text-textMuted">
          <label className="inline-flex cursor-pointer items-center gap-2 select-none">
            <input type="checkbox" checked={nurOffen} onChange={(e) => setNurOffen(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent" />
            Nur offene Fahrer anzeigen
          </label>
          <span>{sichtbar.length} von {drivers.length} angezeigt</span>
        </div>
      </div>

      {fehler && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{fehler}</div>
      )}

      {/* Fahrerliste */}
      <div className="space-y-3">
        {drivers.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border bg-surface p-12 text-center text-sm text-textMuted">
            Keine aktiven Fahrer. Lege zuerst unter „Fahrer" welche an.
          </div>
        )}

        {sichtbar.map((r) => {
          const auf = !!open[r.d.id]
          return (
            <div key={r.d.id}
              className={`overflow-hidden rounded-2xl border transition-colors ${
                r.gefuellt ? 'border-accent/30 bg-surface' : 'border-border bg-surface/50'
              }`}>
              {/* Akzent-Leiste links */}
              <div className="flex">
                <div className={`w-1.5 shrink-0 ${r.gefuellt ? 'bg-accent' : 'bg-transparent'}`} />

                <div className="min-w-0 flex-1">
                  {/* Kernzeile */}
                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                    {/* Name + Status */}
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        r.gefuellt ? 'bg-accent/15 text-accent' : 'bg-border text-textMuted'
                      }`}>{r.sn}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-text">{r.d.name}</span>
                          {r.gefuellt
                            ? <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[0.65rem] font-medium text-success">● erfasst</span>
                            : <span className="inline-flex shrink-0 items-center rounded-full bg-border/60 px-2 py-0.5 text-[0.65rem] font-medium text-textMuted">offen</span>}
                        </div>
                        {r.d.employeeNumber && <div className="text-xs text-textMuted">Pers.-Nr. {r.d.employeeNumber}</div>}
                      </div>
                    </div>

                    {/* Kernfelder */}
                    <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:items-end">
                      <Field label="€ / Std">
                        <Unit suffix="€"><input className="inp pr-6 text-right tabular-nums" inputMode="decimal"
                          value={r.e.rate} onChange={(e) => set(r.d.id, 'rate', e.target.value)} /></Unit>
                      </Field>
                      <Field label="Gesamt Std" tip="Bezahlte Stunden = Nettoarbeit + Pause. Die Pause ist bezahlt, der Arbeitsweg zählt nie mit.">
                        <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                          placeholder="0" value={r.e.total} onChange={(e) => set(r.d.id, 'total', e.target.value)} /></Unit>
                      </Field>
                      <div className="col-span-2 text-right sm:col-auto sm:min-w-[7rem]">
                        <div className="text-[0.62rem] font-medium uppercase tracking-wider text-textMuted">Lohn (ca.)</div>
                        <div className={`text-base font-semibold tabular-nums ${r.gefuellt ? 'text-text' : 'text-textMuted'}`}>
                          {eur(r.gesamt)} €
                        </div>
                      </div>
                    </div>

                    {/* Aufklapp-Button */}
                    <button onClick={() => setOpen((o) => ({ ...o, [r.d.id]: !o[r.d.id] }))}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-textMuted transition-colors hover:border-accent hover:text-text sm:self-center"
                      aria-expanded={auf}>
                      Details
                      {(r.zuschlag || r.vermerk) && !auf && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Enthält Angaben" />}
                      <span className={`transition-transform duration-300 ${auf ? 'rotate-180' : ''}`}>⌄</span>
                    </button>
                  </div>

                  {/* Aufklappbereich */}
                  <div className={`grid transition-all duration-300 ease-out ${auf ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                    <div className="overflow-hidden">
                      <div className="space-y-4 border-t border-border/70 bg-bg/40 p-4">
                        <section>
                          <h4 className="mb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-textMuted">
                            Zuschläge – Zielvorgabe (Std)
                          </h4>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="Sonntag 50 %">
                              <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                                placeholder="0" value={r.e.sunday} onChange={(e) => set(r.d.id, 'sunday', e.target.value)} /></Unit>
                            </Field>
                            <Field label="Nacht 25 %">
                              <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                                placeholder="0" value={r.e.night25} onChange={(e) => set(r.d.id, 'night25', e.target.value)} /></Unit>
                            </Field>
                            <Field label="Nacht 40 %">
                              <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                                placeholder="0" value={r.e.night40} onChange={(e) => set(r.d.id, 'night40', e.target.value)} /></Unit>
                            </Field>
                          </div>
                        </section>
                        <section>
                          <h4 className="mb-2 text-[0.68rem] font-semibold uppercase tracking-wider text-textMuted">Vermerke</h4>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="Krank (Zeitraum)">
                              <input className="inp" value={r.e.krank} placeholder="z. B. 16.–20.10."
                                onChange={(e) => set(r.d.id, 'krank', e.target.value)} />
                            </Field>
                            <Field label="1 % Brutto">
                              <input className="inp" value={r.e.brutto} placeholder="Nein"
                                onChange={(e) => set(r.d.id, 'brutto', e.target.value)} />
                            </Field>
                            <Field label="Abmelden / Status">
                              <input className="inp" value={r.e.abmelden} placeholder="z. B. ab Sept. Minijob"
                                onChange={(e) => set(r.d.id, 'abmelden', e.target.value)} />
                            </Field>
                          </div>
                        </section>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}

        {drivers.length > 0 && sichtbar.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border bg-surface p-10 text-center text-sm text-textMuted">
            {nurOffen ? 'Alle angezeigten Fahrer sind erfasst. 🎉' : `Kein Fahrer passt zu „${suche}".`}
          </div>
        )}
      </div>

      {/* Kompakte Fußnote */}
      <p className="text-xs leading-relaxed text-textMuted/80">
        Beim Erzeugen entsteht pro Fahrer ein tageweiser Monats-Stundenzettel als <strong className="text-textMuted">Excel mit Formeln</strong>:
        die gelben Felder (Von/Bis/Pause) sind editierbar, Netto, Zuschläge (§ 3b: Nacht 25/40 %, Sonntag 50 %) und Lohn rechnen
        sich automatisch neu. „Lohn (ca.)" hier ist eine Schnellschätzung. Stundenlohn je Zeile editierbar (dauerhaft im Fahrer-Datensatz).
      </p>
    </div>
  )
}

/** Feld mit Label und optionalem Tooltip (Hover/Fokus). */
function Field({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-[0.62rem] font-medium uppercase tracking-wider text-textMuted">
        {label}
        {tip && (
          <span className="group relative inline-flex">
            <span className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-border text-[0.6rem] leading-none text-textMuted">?</span>
            <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-56 -translate-x-1/2 rounded-lg border border-border bg-surfaceAlt p-2 text-[0.7rem] font-normal normal-case leading-snug text-text opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
              {tip}
            </span>
          </span>
        )}
      </span>
      {children}
    </label>
  )
}

/** Eingabe mit Einheit-Suffix (€, Std). */
function Unit({ suffix, children }: { suffix: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-textMuted">{suffix}</span>
    </div>
  )
}
