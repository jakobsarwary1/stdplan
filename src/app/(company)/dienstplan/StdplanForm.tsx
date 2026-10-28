'use client'

import { useEffect, useMemo, useState } from 'react'
import { erstellePlan, type ManualResult } from '@/lib/planning/manual'
import UberCsvPlan from './UberCsvPlan'

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

type PlanShift = { date: string; von: string; bis: string; pause: number; netto: number; bezahlt: number; ruhe: number | null; n25: number; n40: number; so: number }
type PlanSum = { netto: number; bezahlt: number; n25: number; n40: number; so: number; minRuhe: number | null; ruheVerletzt: boolean }
type PlanZiel = { bezahlt: number; sunday: number; n25: number; n40: number }
type PlanDriver = { name: string; employeeNumber: string | null; ziel: PlanZiel; manuell?: boolean; tage: number; paidSum: number; warning: string | null; summe: PlanSum; shifts: PlanShift[] }

const istSonntag = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay() === 0 }

const n2 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const MONAT_KURZ = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.']
const WOCHENTAG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']

function isoTeile(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d, dow: new Date(y, m - 1, d).getDay() }
}

/** „Montag, der 5.“ */
function tagSatz(iso: string) {
  const { d, dow } = isoTeile(iso)
  return `${WOCHENTAG[dow]}, der ${d}.`
}

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
  const [planBusy, setPlanBusy] = useState(false)
  const [plan, setPlan] = useState<PlanDriver[] | null>(null)
  const [planAktiv, setPlanAktiv] = useState<string>('')

  const storageKey = `stdplan:v1:${year}-${String(month).padStart(2, '0')}`

  useEffect(() => {
    let geladen: Record<string, Partial<Entry>> = {}
    try {
      const roh = localStorage.getItem(storageKey)
      if (roh) geladen = JSON.parse(roh)
    } catch { /* ignore */ }
    const next: Record<string, Entry> = {}
    for (const d of drivers) {
      const alt = geladen[d.id]
      const basis = leer(d.rate)
      // Alte Tageslisten (Aktiv/Von/Bis) werden verworfen. Der Plan kommt aus den Summen.
      next[d.id] = alt ? {
        rate: alt.rate ?? basis.rate,
        total: alt.total ?? '',
        sunday: alt.sunday ?? '',
        night25: alt.night25 ?? '',
        night40: alt.night40 ?? '',
        krank: alt.krank ?? '',
        brutto: alt.brutto ?? '',
        abmelden: alt.abmelden ?? '',
      } : basis
    }
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
    const plan: ManualResult | null = total > 0
      ? erstellePlan(year, month, { bezahlt: total, sunday, n25, n40 })
      : null
    const basis = plan ? plan.summe.netto : 0 // Lohn auf die bezahlte Arbeitszeit (Spanne minus Pause)
    const soStd = plan ? plan.summe.so : 0
    const n25Std = plan ? plan.summe.n25 : 0
    const n40Std = plan ? plan.summe.n40 : 0
    const gesamt = basis * rate + soStd * rate * 0.5 + n25Std * rate * 0.25 + n40Std * rate * 0.4
    const vermerk = !!(e.krank || e.brutto || e.abmelden)
    return { sn: i + 1, d, e, rate, total, sunday, n25, n40, gesamt, gefuellt: total > 0, plan, vermerk }
  }), [drivers, data, year, month])

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

  async function planen(focus?: string) {
    setPlanBusy(true); setFehler(null)
    try {
      const rows = berechnet.filter((r) => r.gefuellt).map((r) => ({
        name: r.d.name, employeeNumber: r.d.employeeNumber, rate: r.rate,
        total: num(r.e.total), sunday: num(r.e.sunday), night25: num(r.e.night25), night40: num(r.e.night40),
      }))
      const res = await fetch('/api/dienstplan/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, rows }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Planung fehlgeschlagen')
      const ds = (j.drivers as PlanDriver[]) ?? []
      setPlan(ds)
      setPlanAktiv((focus && ds.some((d) => d.name === focus) ? focus : ds[0]?.name) ?? '')
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setPlanBusy(false)
    }
  }

  // Modal mit Esc schließen.
  useEffect(() => {
    if (!plan) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPlan(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [plan])

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      {/* Titelzeile + Primäraktion */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dienstplan erstellen</h1>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-textMuted">
            Aus der Uber- oder Fahrlygo-Fahrtliste wird je Fahrer der Monat gesetzt. Darunter bleibt die Planung aus den Monatsstunden.
          </p>
        </div>
        <button onClick={() => planen()} disabled={planBusy || ausgefuellt === 0}
          className="group inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-bg shadow-lg shadow-accent/20 transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          title="Erstellt die Schicht-Vorschau. Die Excel-Datei lädst du erst danach in der Vorschau herunter.">
          {planBusy
            ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-bg/40 border-t-bg" /> Erstelle Vorschau…</>
            : <><span aria-hidden>🗓</span> Stundenzettel-Vorschau erstellen</>}
        </button>
      </div>

      <UberCsvPlan />

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

      {/* Planungs-Vorschau (automatische Schichten, ohne Fahrzeuge) */}
      {plan && (() => {
        const aktiv = plan.find((p) => p.name === planAktiv) ?? plan[0]
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
            role="dialog" aria-modal="true" onClick={() => setPlan(null)}>
          <div className="my-6 w-full max-w-4xl overflow-hidden rounded-2xl border border-accent/30 bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h3 className="font-semibold text-text">Planungs-Vorschau</h3>
                <p className="text-xs text-textMuted">
                  {`Aus den Monatsstunden für ${monthLabel}. Tage und Uhrzeiten setzt das System.`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={erzeugen} disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-bg transition-all hover:brightness-105 disabled:opacity-50">
                  {busy
                    ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-bg/40 border-t-bg" /> Lädt…</>
                    : <><span aria-hidden>↧</span> Excel herunterladen</>}
                </button>
                <button onClick={() => setPlan(null)}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-textMuted transition-colors hover:text-text">✕</button>
              </div>
            </div>

            {!aktiv ? (
              <div className="px-4 py-6 text-center text-sm text-textMuted">Keine Fahrer mit Stunden.</div>
            ) : (
              <>
                {/* Fahrer-Auswahl (Tabs) */}
                {plan.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto border-b border-border px-4 py-2.5">
                    {plan.map((p) => (
                      <button key={p.name} onClick={() => setPlanAktiv(p.name)}
                        className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                          p.name === aktiv.name ? 'bg-accent text-bg' : 'bg-bg text-textMuted hover:text-text'
                        }`}>
                        {p.name}
                        {(p.warning || p.summe.ruheVerletzt) && <span className={`h-1.5 w-1.5 rounded-full ${p.name === aktiv.name ? 'bg-bg/60' : 'bg-amber-400'}`} />}
                      </button>
                    ))}
                  </div>
                )}

                {/* Ziel vs. Ist für alle vier Werte */}
                <div className="space-y-3 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-text">{aktiv.name}</span>
                    {aktiv.employeeNumber && <span className="text-xs text-textMuted">Pers.-Nr. {aktiv.employeeNumber}</span>}
                    <span className="text-xs text-textMuted">· {aktiv.tage} Arbeitstage</span>
                    {aktiv.summe.ruheVerletzt && (
                      <span className="rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger"
                        title={`Kürzeste Ruhezeit ${n2(aktiv.summe.minRuhe ?? 0)} h`}>Ruhe &lt; 11 h</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                    <ZielIst label="Gesamt (brutto)" ziel={aktiv.ziel.bezahlt} ist={aktiv.summe.bezahlt} />
                    <ZielIst label="Sonntag 50 %" ziel={aktiv.ziel.sunday} ist={aktiv.summe.so} />
                    <ZielIst label="Nacht 40 %" ziel={aktiv.ziel.n40} ist={aktiv.summe.n40} />
                    <ZielIst label="Nacht 25 %" ziel={aktiv.ziel.n25} ist={aktiv.summe.n25} />
                  </div>
                </div>

                {aktiv.warning && (
                  <p className="mx-4 mb-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-300">⚠ {aktiv.warning}</p>
                )}

                <div className="overflow-x-auto px-4 pb-3">
                  <table className="w-full min-w-[46rem] text-sm">
                    <thead>
                      <tr className="text-left text-[0.65rem] uppercase tracking-wide text-textMuted">
                        <th className="py-1 pr-4 font-medium">Datum</th>
                        <th className="py-1 pr-4 font-medium">Von–Bis</th>
                        <th className="py-1 pr-3 text-right font-medium">Pause</th>
                        <th className="py-1 pr-3 text-right font-medium">Brutto</th>
                        <th className="py-1 pr-3 text-right font-semibold text-text">Bezahlt</th>
                        <th className="py-1 pr-3 text-right font-medium">Ruhe</th>
                        <th className="py-1 pr-3 text-right font-medium">N 25%</th>
                        <th className="py-1 pr-3 text-right font-medium">N 40%</th>
                        <th className="py-1 text-right font-medium">So 50%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aktiv.shifts.map((s, i) => {
                        const so = istSonntag(s.date)
                        const nacht = s.n40 > 0 || s.n25 > 0
                        const kurz = s.bezahlt > 0 && s.bezahlt < 4
                        return (
                          <tr key={i} className={`border-t border-border/40 ${so ? 'bg-accent/[0.06]' : i % 2 ? 'bg-bg/20' : ''}`}>
                            <td className={`whitespace-nowrap py-1.5 pr-4 ${so ? 'font-medium text-accent' : ''}`}>{tagSatz(s.date)}</td>
                            <td className="whitespace-nowrap py-1.5 pr-4 tabular-nums">
                              {nacht && <span className="mr-1" title="Schicht mit Nachtzuschlag">🌙</span>}{s.von}–{s.bis}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums text-textMuted">{s.pause}′</td>
                            <td className={`py-1.5 pr-3 text-right tabular-nums ${kurz ? 'text-amber-300' : 'text-textMuted'}`}
                              title={kurz ? 'Kurze Schicht (< 4 h)' : undefined}>{n2(s.bezahlt)}</td>
                            <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-text">{n2(s.netto)}</td>
                            <td className={`py-1.5 pr-3 text-right tabular-nums ${s.ruhe != null && s.ruhe < 11 ? 'font-semibold text-danger' : 'text-textMuted'}`}
                              title={s.ruhe != null && s.ruhe < 11 ? 'Ruhezeit unter 11 h (§ 5 ArbZG)' : undefined}>
                              {s.ruhe == null ? '–' : n2(s.ruhe)}
                            </td>
                            <td className={`py-1.5 pr-3 text-right tabular-nums ${s.n25 ? 'text-text' : 'text-textMuted'}`}>{s.n25 ? n2(s.n25) : '–'}</td>
                            <td className={`py-1.5 pr-3 text-right tabular-nums ${s.n40 ? 'text-text' : 'text-textMuted'}`}>{s.n40 ? n2(s.n40) : '–'}</td>
                            <td className={`py-1.5 text-right tabular-nums ${s.so ? 'font-medium text-accent' : 'text-textMuted'}`}>{s.so ? n2(s.so) : '–'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border font-semibold">
                        <td className="py-2 pr-4" colSpan={3}>Summe</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-textMuted">{n2(aktiv.summe.bezahlt)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-text">{n2(aktiv.summe.netto)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-textMuted">
                          {aktiv.summe.minRuhe == null ? '–' : <span className={aktiv.summe.ruheVerletzt ? 'text-danger' : ''}>min {n2(aktiv.summe.minRuhe)}</span>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{n2(aktiv.summe.n25)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{n2(aktiv.summe.n40)}</td>
                        <td className="py-2 text-right tabular-nums">{n2(aktiv.summe.so)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}

            <div className="border-t border-border px-4 py-2 text-xs leading-relaxed text-textMuted">
              <strong className="text-text">Brutto</strong> = Beginn→Ende (Anwesenheit, Pause inklusive) ·
              <strong className="text-text"> Bezahlt</strong> = Brutto minus Pause (Lohnbasis, Pause unbezahlt) · Ruhe = zur Vorschicht (≥ 11 h, § 5 ArbZG, sonst rot) ·
              N 25 % (04–06 &amp; 20–24) · N 40 % (00–04, steuerfrei) · So 50 % (§ 3b EStG).
              <span className="text-accent"> Sonntage farbig</span>, 🌙 = Nachtzuschlag, kurze Schichten (&lt; 4 h) orange.
              Oben „Excel herunterladen" lädt denselben Plan mit editierbaren Formeln.
            </div>
          </div>
          </div>
        )
      })()}

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
                  {/* Kopf: Name, Lohn, Aktionen */}
                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
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

                    <div className="text-right sm:min-w-[7.5rem]">
                      <div className="text-[0.62rem] font-medium uppercase tracking-wider text-textMuted">Lohn (ca.)</div>
                      <div className={`text-base font-semibold tabular-nums ${r.gefuellt ? 'text-text' : 'text-textMuted'}`}>
                        {eur(r.gesamt)} €
                      </div>
                      {r.plan && (r.plan.summe.so > 0 || r.plan.summe.n25 > 0 || r.plan.summe.n40 > 0) && (
                        <div className="text-[0.62rem] text-textMuted">inkl. Zuschläge</div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 sm:self-center">
                      <button onClick={() => planen(r.d.name)} disabled={!r.gefuellt || planBusy}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-textMuted transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                        title={r.gefuellt ? 'Vorschau und Excel für diesen Fahrer' : 'Erst Gesamtstunden eintragen'}>
                        <span aria-hidden>👁</span> Vorschau
                      </button>
                      <button onClick={() => setOpen((o) => ({ ...o, [r.d.id]: !o[r.d.id] }))}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-textMuted transition-colors hover:border-accent hover:text-text"
                        aria-expanded={auf}>
                        Vermerke
                        {r.vermerk && !auf && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Enthält Vermerke" />}
                        <span className={`transition-transform duration-300 ${auf ? 'rotate-180' : ''}`}>⌄</span>
                      </button>
                    </div>
                  </div>

                  {/* Nur die Monatssummen. Tage und Uhrzeiten setzt das System. */}
                  <div className="grid grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-3 lg:grid-cols-5">
                    <Field label="€ / Std">
                      <Unit suffix="€"><input className="inp pr-6 text-right tabular-nums" inputMode="decimal"
                        value={r.e.rate} onChange={(e) => set(r.d.id, 'rate', e.target.value)} /></Unit>
                    </Field>
                    <Field label="Gesamt Std" tip="Brutto-/Anwesenheitsstunden des Monats (Beginn→Ende, Pause inklusive). Das System verteilt sie auf die Tage; bezahlt wird die Arbeitszeit = Brutto minus Pause.">
                      <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                        placeholder="0" value={r.e.total} onChange={(e) => set(r.d.id, 'total', e.target.value)} /></Unit>
                    </Field>
                    <Field label="Sonntag" tip="Arbeitsstunden am Sonntag, ohne Pause. Das System legt sie auf die Sonntage.">
                      <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                        placeholder="0" value={r.e.sunday} onChange={(e) => set(r.d.id, 'sunday', e.target.value)} /></Unit>
                    </Field>
                    <Field label="Nacht 40 %" tip="Arbeitsstunden von 0 bis 4 Uhr, ohne Pause.">
                      <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                        placeholder="0" value={r.e.night40} onChange={(e) => set(r.d.id, 'night40', e.target.value)} /></Unit>
                    </Field>
                    <Field label="Nacht 25 %" tip="Arbeitsstunden von 20 bis 24 Uhr und von 4 bis 6 Uhr, ohne Pause.">
                      <Unit suffix="Std"><input className="inp pr-9 text-right tabular-nums" inputMode="decimal"
                        placeholder="0" value={r.e.night25} onChange={(e) => set(r.d.id, 'night25', e.target.value)} /></Unit>
                    </Field>
                  </div>

                  {r.plan && (
                    <WochenPlan year={year} month={month} plan={r.plan} ziel={{ bezahlt: r.total, sunday: r.sunday, n40: r.n40, n25: r.n25 }} />
                  )}

                  {/* Vermerke */}
                  <div className={`grid transition-all duration-300 ease-out ${auf ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                    <div className="overflow-hidden">
                      <div className="space-y-4 border-t border-border/70 bg-bg/40 p-4">
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
        Beim Erzeugen entsteht pro Fahrer ein tageweiser Monats-Stundenzettel als <strong className="text-textMuted">Excel mit Formeln</strong>.
        Die Uhrzeiten kommen aus diesem Plan. In Excel bleiben Von/Bis/Pause gelb und editierbar, Zuschläge (§ 3b: Nacht 25/40 %, Sonntag 50 %) und Lohn rechnen sich neu.
        „Lohn (ca.)" ist Grundlohn plus die Zuschläge, die der Plan wirklich erreicht.
      </p>
    </div>
  )
}

/** Lesbarer Wochenplan. Nur Anzeige: die Tage und Uhrzeiten kommen aus erstellePlan. */
function WochenPlan({ year, month, plan, ziel }: {
  year: number
  month: number
  plan: ManualResult
  ziel: { bezahlt: number; sunday: number; n40: number; n25: number }
}) {
  const byDate = new Map(plan.tage.filter((t) => t.bezahlt > 0).map((t) => [t.date, t]))
  const gruppen = new Map<string, string[]>()
  const cursor = new Date(year, month - 1, 1)
  while (cursor.getMonth() === month - 1) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    const { y, m, d, dow } = isoTeile(iso)
    const montag = new Date(y, m - 1, d - ((dow + 6) % 7))
    const key = `${montag.getFullYear()}-${String(montag.getMonth() + 1).padStart(2, '0')}-${String(montag.getDate()).padStart(2, '0')}`
    gruppen.set(key, [...(gruppen.get(key) ?? []), iso])
    cursor.setDate(cursor.getDate() + 1)
  }

  return (
    <div className="space-y-3 border-t border-border/70 px-4 py-4">
      <div className="flex flex-wrap gap-1.5">
        <SummenChip label="Brutto" ist={plan.summe.bezahlt} soll={ziel.bezahlt} />
        <SummenChip label="Bezahlt" ist={plan.summe.netto} soll={plan.summe.netto} />
        <SummenChip label="Sonntag" ist={plan.summe.so} soll={ziel.sunday} accent />
        <SummenChip label="Nacht 40 %" ist={plan.summe.n40} soll={ziel.n40} />
        <SummenChip label="Nacht 25 %" ist={plan.summe.n25} soll={ziel.n25} />
        <span className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-[0.7rem] text-textMuted">
          {byDate.size} Schichten
        </span>
      </div>

      {plan.warnings.map((w) => (
        <p key={w} className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200">{w}</p>
      ))}

      <div className="space-y-2">
        {[...gruppen.values()].map((dates) => {
          const gearbeitet = dates.flatMap((iso) => {
            const t = byDate.get(iso)
            return t ? [t] : []
          })
          const frei = dates.filter((iso) => !byDate.has(iso))
          const von = isoTeile(dates[0])
          const bis = isoTeile(dates[dates.length - 1])
          return (
            <div key={dates[0]} className="rounded-xl border border-border/80 bg-bg/50 px-3 py-2.5">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-textMuted">
                  {von.d}. {MONAT_KURZ[von.m - 1]} – {bis.d}. {MONAT_KURZ[bis.m - 1]}
                </div>
                <div className={`text-[0.68rem] ${frei.length > 2 ? 'font-medium text-amber-300' : 'text-textMuted'}`}>
                  {frei.length === 0 ? 'keine freien Tage' : frei.length === 1 ? '1 Tag frei' : `${frei.length} Tage frei`}
                </div>
              </div>

              {gearbeitet.map((t) => {
                const nacht = t.n25 > 0 || t.n40 > 0
                const so = t.so > 0
                return (
                  <div key={t.date} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-border/40 py-1.5 first:border-t-0">
                    <div className={`min-w-[10.5rem] text-sm ${so ? 'font-medium text-accent' : 'text-text'}`}>{tagSatz(t.date)}</div>
                    <div className="text-sm tabular-nums text-text">
                      {t.start}–{t.ende}
                      {t.overnight && <span className="ml-1.5 text-[0.65rem] uppercase tracking-wide text-textMuted">Folgetag</span>}
                    </div>
                    <div className="text-xs tabular-nums text-textMuted">
                      {n2(t.bezahlt)} Std{t.pause > 0 ? ` · ${t.pause} min Pause` : ''}
                    </div>
                    <div className="ml-auto flex flex-wrap gap-1">
                      {so && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[0.65rem] font-medium text-accent">Sonntag</span>}
                      {nacht && <span className="rounded-full bg-surfaceAlt px-2 py-0.5 text-[0.65rem] font-medium text-text">Nacht</span>}
                      {t.ruhe != null && t.ruhe < 11 && (
                        <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[0.65rem] font-medium text-danger">Ruhe {n2(t.ruhe)} h</span>
                      )}
                    </div>
                  </div>
                )
              })}

              {frei.length > 0 && (
                <p className={`${gearbeitet.length > 0 ? 'mt-1 border-t border-border/40 pt-1.5' : ''} text-xs leading-relaxed text-textMuted`}>
                  Frei: {frei.map(tagSatz).join(' · ')}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SummenChip({ label, ist, soll, accent }: { label: string; ist: number; soll: number; accent?: boolean }) {
  const off = Math.abs(ist - soll) > 0.3
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.7rem] tabular-nums ${
      off ? 'border-amber-400/40 bg-amber-400/10 text-amber-200' : accent ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-text'
    }`}>
      <span className={off || accent ? '' : 'text-textMuted'}>{label}</span>
      {off ? `${n2(ist)} von ${n2(soll)}` : n2(ist)} Std
    </span>
  )
}

/** Ziel-vs-Ist-Kachel mit Ampel (grün ≤ 0,1 · gelb ≤ 0,25 · rot darüber). */
function ZielIst({ label, ziel, ist, sub }: { label: string; ziel: number; ist: number; sub?: string }) {
  const abw = Math.round((ist - ziel) * 100) / 100
  const a = Math.abs(abw)
  const n = (x: number) => x.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const tone = a <= 0.1 ? 'border-success/40 bg-success/5' : a <= 0.25 ? 'border-amber-400/40 bg-amber-400/5' : 'border-danger/40 bg-danger/5'
  const txt = a <= 0.1 ? 'text-success' : a <= 0.25 ? 'text-amber-300' : 'text-danger'
  return (
    <div className={`rounded-xl border px-3 py-2 ${tone}`}>
      <div className="text-[0.6rem] font-medium uppercase tracking-wide text-textMuted">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-sm font-semibold tabular-nums text-text">{n(ist)}</span>
        <span className="text-[0.62rem] text-textMuted">/ {n(ziel)} Ziel</span>
        <span className={`ml-auto text-[0.62rem] font-medium tabular-nums ${txt}`} title={`Abweichung ${abw > 0 ? '+' : ''}${n(abw)} Std`}>
          {abw === 0 ? '✓ exakt' : (abw > 0 ? '+' : '') + n(abw)}
        </span>
      </div>
      {sub && <div className="mt-0.5 text-[0.58rem] text-textMuted">{sub}</div>}
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
