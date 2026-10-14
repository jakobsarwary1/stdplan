'use client'

import { useEffect, useMemo, useState } from 'react'
import { berechneManuell, schlageVor, type ManualResult } from '@/lib/planning/manual'

type Driver = { id: string; name: string; employeeNumber: string; rate: number }

/** Ein vom Nutzer gesetzter Tag. Von/Bis ist das Fenster, nicht die fertige Schicht. */
type DayDraft = { date: string; aktiv: boolean; von: string; bis: string; bezahlt: string }

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
  tage?: DayDraft[]
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

function monthIso(year: number, month: number): string[] {
  const out: string[] = []
  const d = new Date(year, month - 1, 1)
  while (d.getMonth() === month - 1) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

function fmtStd(n: number): string {
  return String(Math.round(n * 100) / 100).replace('.', ',')
}

function leererTag(date: string): DayDraft {
  return { date, aktiv: false, von: '', bis: '', bezahlt: '' }
}
const istSonntag = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay() === 0 }

const n2 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const dLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  return `${WT[dow]} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`
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
  const [vorschlagHinweis, setVorschlagHinweis] = useState<Record<string, string>>({})

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

  const tagAendern = (id: string, date: string, patch: Partial<DayDraft>) =>
    setData((d) => {
      const e = d[id] ?? leer(0)
      const by = new Map((e.tage ?? []).map((t) => [t.date, t]))
      const next = { ...(by.get(date) ?? leererTag(date)), ...patch }
      if (patch.aktiv === undefined && (num(next.bezahlt) > 0 || next.von || next.bis)) next.aktiv = true
      by.set(date, next)
      const tage = monthIso(year, month).map((dt) => by.get(dt) ?? leererTag(dt))
      return { ...d, [id]: { ...e, tage } }
    })

  const tageLeeren = (id: string) => {
    setData((d) => ({ ...d, [id]: { ...d[id], tage: [] } }))
    setVorschlagHinweis((h) => ({ ...h, [id]: '' }))
  }

  const vorschlagEinsetzen = (id: string) => {
    const e = data[id] ?? leer(0)
    const res = schlageVor(year, month, {
      bezahlt: num(e.total), sunday: num(e.sunday), n25: num(e.night25), n40: num(e.night40),
    })
    const by = new Map(res.tage.map((t) => [t.date, t]))
    const tage = monthIso(year, month).map((date) => {
      const hit = by.get(date)
      return hit
        ? { date, aktiv: true, von: hit.von, bis: hit.bis, bezahlt: fmtStd(hit.bezahlt) }
        : leererTag(date)
    })
    setData((d) => ({ ...d, [id]: { ...(d[id] ?? leer(0)), tage } }))
    setOpen((o) => ({ ...o, [id]: true }))
    setVorschlagHinweis((h) => ({ ...h, [id]: res.warnings.join(' ') }))
  }

  const tageFuerApi = (e: Entry) => (e.tage ?? [])
    .filter((t) => t.aktiv && num(t.bezahlt) > 0)
    .map((t) => ({ date: t.date, von: t.von, bis: t.bis, bezahlt: num(t.bezahlt) }))

  const monthLabel = `${MONATE[month - 1]} ${year}`

  const berechnet = useMemo(() => drivers.map((d, i) => {
    const e = data[d.id] ?? leer(d.rate)
    const rate = num(e.rate)
    const total = num(e.total)
    const sunday = num(e.sunday)
    const n25 = num(e.night25)
    const n40 = num(e.night40)
    const aktive = (e.tage ?? []).filter((t) => t.aktiv && num(t.bezahlt) > 0)
    const calc: ManualResult | null = aktive.length
      ? berechneManuell(aktive.map((t) => ({ date: t.date, aktiv: true, von: t.von, bis: t.bis, bezahlt: num(t.bezahlt) })))
      : null
    const manuell = aktive.length > 0
    const basis = calc && calc.summe.bezahlt > 0 ? calc.summe.bezahlt : total
    const soStd = calc && calc.summe.bezahlt > 0 ? calc.summe.so : sunday
    const n25Std = calc && calc.summe.bezahlt > 0 ? calc.summe.n25 : n25
    const n40Std = calc && calc.summe.bezahlt > 0 ? calc.summe.n40 : n40
    const gesamt = basis * rate + soStd * rate * 0.5 + n25Std * rate * 0.25 + n40Std * rate * 0.4
    const zuschlag = sunday > 0 || n25 > 0 || n40 > 0
    const vermerk = !!(e.krank || e.brutto || e.abmelden)
    return { sn: i + 1, d, e, rate, total, gesamt, gefuellt: total > 0 || manuell, manuell, calc, zuschlag, vermerk }
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
        krank: r.e.krank, brutto: r.e.brutto, abmelden: r.e.abmelden, tage: tageFuerApi(r.e),
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
        tage: tageFuerApi(r.e),
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
            Je Fahrer die bezahlten Stunden eintragen. Unter Details kannst du die Tage, das
            Von–Bis-Fenster und die Bezahlt-Stunden selbst setzen – Start, Pause, Ende und Zuschläge
            rechnet das System. Der Vorschlag ist optional und überschreibbar.
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
                  {aktiv?.manuell
                    ? `Aus den eingetragenen Tagen für ${monthLabel} – nur Vorschau, nichts wird gespeichert.`
                    : `Automatisch verteilte Schichten für ${monthLabel} – nur Vorschau, nichts wird gespeichert (ohne Fahrzeuge).`}
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
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <ZielIst label="Gesamt (bezahlt)" ziel={aktiv.ziel.bezahlt} ist={aktiv.summe.bezahlt} />
                    <ZielIst label="Sonntag 50 %" ziel={aktiv.ziel.sunday} ist={aktiv.summe.so} />
                    <ZielIst label="Nacht gesamt" ziel={aktiv.ziel.n25 + aktiv.ziel.n40} ist={aktiv.summe.n25 + aktiv.summe.n40}
                      sub={`tatsächlich 25 % ${n2(aktiv.summe.n25)} · 40 % ${n2(aktiv.summe.n40)}`} />
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
                        <th className="py-1 pr-3 text-right font-semibold text-text">Bezahlt</th>
                        <th className="py-1 pr-3 text-right font-medium">Netto</th>
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
                            <td className={`whitespace-nowrap py-1.5 pr-4 ${so ? 'font-medium text-accent' : ''}`}>{dLabel(s.date)}</td>
                            <td className="whitespace-nowrap py-1.5 pr-4 tabular-nums">
                              {nacht && <span className="mr-1" title="Schicht mit Nachtzuschlag">🌙</span>}{s.von}–{s.bis}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums text-textMuted">{s.pause}′</td>
                            <td className={`py-1.5 pr-3 text-right font-medium tabular-nums ${kurz ? 'text-amber-300' : 'text-text'}`}
                              title={kurz ? 'Kurze Schicht (< 4 h)' : undefined}>{n2(s.bezahlt)}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums text-textMuted">{n2(s.netto)}</td>
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
                        <td className="py-2 pr-3 text-right tabular-nums text-text">{n2(aktiv.summe.bezahlt)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-textMuted">{n2(aktiv.summe.netto)}</td>
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
              <strong className="text-text">Bezahlt</strong> = „Gesamt Std" (Beginn→Ende inkl. bezahlter Pause, Lohnbasis) ·
              <strong className="text-text"> Netto</strong> = ohne Pause · Ruhe = zur Vorschicht (≥ 11 h, § 5 ArbZG, sonst rot) ·
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

                    {/* Aktionen: Vorschau + Details */}
                    <div className="flex items-center gap-2 sm:self-center">
                      <button onClick={() => planen(r.d.name)} disabled={!r.gefuellt || planBusy}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-textMuted transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                        title={r.gefuellt ? 'Planungs-Vorschau für diesen Fahrer öffnen' : 'Erst Gesamtstunden eintragen'}>
                        <span aria-hidden>👁</span> Vorschau
                      </button>
                      <button onClick={() => setOpen((o) => ({ ...o, [r.d.id]: !o[r.d.id] }))}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-textMuted transition-colors hover:border-accent hover:text-text"
                        aria-expanded={auf}>
                        Details
                        {(r.zuschlag || r.vermerk || r.manuell) && !auf && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Enthält Angaben" />}
                        <span className={`transition-transform duration-300 ${auf ? 'rotate-180' : ''}`}>⌄</span>
                      </button>
                    </div>
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
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <h4 className="text-[0.68rem] font-semibold uppercase tracking-wider text-textMuted">
                              Tage, Fenster, Bezahlt-Stunden
                            </h4>
                            <div className="flex items-center gap-2">
                              <button type="button" onClick={() => vorschlagEinsetzen(r.d.id)} disabled={r.total <= 0}
                                className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-textMuted transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                                title="Füllt die Tage aus den Monatsstunden. Sonntag, dann Nacht, dann der Rest. Danach überschreibbar.">
                                Vorschlag einsetzen
                              </button>
                              {r.manuell && (
                                <button type="button" onClick={() => tageLeeren(r.d.id)}
                                  className="rounded-lg px-2 py-1 text-xs text-textMuted hover:text-text">
                                  Tage zurücksetzen
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="mb-2 text-xs leading-relaxed text-textMuted">
                            Du setzt die Tage, das Von–Bis-Fenster und die Bezahlt-Stunden. Das System rechnet Start, Pause, Ende, Netto, Nacht 25/40 %, Sonntag 50 % und die Ruhe zur Vorschicht.
                            Ohne gesetzte Tage bleibt die bisherige automatische Verteilung.
                          </p>
                          {vorschlagHinweis[r.d.id] && (
                            <p className="mb-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-300">{vorschlagHinweis[r.d.id]}</p>
                          )}
                          {r.calc && (
                            <p className="mb-2 text-xs tabular-nums text-textMuted">
                              Summe bezahlt {n2(r.calc.summe.bezahlt)} Std
                              {r.total > 0 && <> · Ziel {n2(r.total)}</>}
                              {' '}· Netto {n2(r.calc.summe.netto)} · N25 {n2(r.calc.summe.n25)} · N40 {n2(r.calc.summe.n40)} · So {n2(r.calc.summe.so)}
                              {r.calc.summe.minRuhe != null && <> · kürzeste Ruhe {n2(r.calc.summe.minRuhe)} h</>}
                            </p>
                          )}
                          <div className="max-h-96 overflow-auto rounded-xl border border-border">
                            <table className="w-full min-w-[62rem] text-xs">
                              <thead className="sticky top-0 bg-surface text-left text-[0.62rem] uppercase tracking-wide text-textMuted">
                                <tr>
                                  <th className="px-2 py-1.5 font-medium">Tag</th>
                                  <th className="px-2 py-1.5 font-medium">Aktiv</th>
                                  <th className="px-2 py-1.5 font-medium">Von</th>
                                  <th className="px-2 py-1.5 font-medium">Bis</th>
                                  <th className="px-2 py-1.5 text-right font-medium">Bezahlt</th>
                                  <th className="px-2 py-1.5 font-medium">Start</th>
                                  <th className="px-2 py-1.5 text-right font-medium">Pause</th>
                                  <th className="px-2 py-1.5 font-medium">Ende</th>
                                  <th className="px-2 py-1.5 text-right font-medium">Netto</th>
                                  <th className="px-2 py-1.5 text-right font-medium">Ruhe</th>
                                  <th className="px-2 py-1.5 text-right font-medium">N 25%</th>
                                  <th className="px-2 py-1.5 text-right font-medium">N 40%</th>
                                  <th className="px-2 py-1.5 text-right font-medium">So 50%</th>
                                </tr>
                              </thead>
                              <tbody>
                                {monthIso(year, month).map((date) => {
                                  const entwurf = (r.e.tage ?? []).find((t) => t.date === date) ?? leererTag(date)
                                  const erg = r.calc?.tage.find((t) => t.date === date)
                                  const so = istSonntag(date)
                                  return (
                                    <tr key={date} className={`border-t border-border/50 ${so ? 'bg-accent/[0.06]' : ''}`} title={erg?.warnung ?? undefined}>
                                      <td className={`whitespace-nowrap px-2 py-1 ${so ? 'font-medium text-accent' : ''}`}>{dLabel(date)}</td>
                                      <td className="px-2 py-1">
                                        <input type="checkbox" checked={entwurf.aktiv} className="h-3.5 w-3.5 accent-accent"
                                          onChange={(e) => tagAendern(r.d.id, date, { aktiv: e.target.checked })} />
                                      </td>
                                      <td className="px-2 py-1">
                                        <input type="time" step={60} value={entwurf.von} className="inp px-1 py-1 text-xs"
                                          onChange={(e) => tagAendern(r.d.id, date, { von: e.target.value })} />
                                      </td>
                                      <td className="px-2 py-1">
                                        <input type="time" step={60} value={entwurf.bis} className="inp px-1 py-1 text-xs"
                                          onChange={(e) => tagAendern(r.d.id, date, { bis: e.target.value })} />
                                      </td>
                                      <td className="px-2 py-1">
                                        <input inputMode="decimal" value={entwurf.bezahlt} placeholder="0"
                                          className="inp w-16 px-1 py-1 text-right text-xs tabular-nums"
                                          onChange={(e) => tagAendern(r.d.id, date, { bezahlt: e.target.value })} />
                                      </td>
                                      <td className="whitespace-nowrap px-2 py-1 tabular-nums">{erg?.start ?? '–'}</td>
                                      <td className="px-2 py-1 text-right tabular-nums text-textMuted">{erg?.aktiv ? `${erg.pause}′` : '–'}</td>
                                      <td className={`whitespace-nowrap px-2 py-1 tabular-nums ${erg?.warnung ? 'text-amber-300' : ''}`}>
                                        {erg?.ende ? `${erg.ende}${erg.overnight ? '+1' : ''}` : '–'}
                                      </td>
                                      <td className="px-2 py-1 text-right tabular-nums">{erg?.aktiv ? n2(erg.netto) : '–'}</td>
                                      <td className={`px-2 py-1 text-right tabular-nums ${erg?.ruhe != null && erg.ruhe < 11 ? 'font-semibold text-danger' : 'text-textMuted'}`}>
                                        {erg?.ruhe == null ? '–' : n2(erg.ruhe)}
                                      </td>
                                      <td className="px-2 py-1 text-right tabular-nums">{erg?.n25 ? n2(erg.n25) : '–'}</td>
                                      <td className="px-2 py-1 text-right tabular-nums">{erg?.n40 ? n2(erg.n40) : '–'}</td>
                                      <td className="px-2 py-1 text-right tabular-nums">{erg?.so ? n2(erg.so) : '–'}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
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
        Beim Erzeugen entsteht pro Fahrer ein tageweiser Monats-Stundenzettel als <strong className="text-textMuted">Excel mit Formeln</strong>.
        Gesetzte Tage gehen mit der gerechneten Start- und Endzeit hinein; ohne Tage verteilt die bisherige Planung die Monatsstunden.
        In Excel bleiben Von/Bis/Pause gelb und editierbar, Zuschläge (§ 3b: Nacht 25/40 %, Sonntag 50 %) und Lohn rechnen sich neu.
        „Lohn (ca.)" hier ist eine Schnellschätzung.
      </p>
    </div>
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
