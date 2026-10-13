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
    const grund = total * rate
    const zSo = sunday * rate * 0.5
    const zN25 = n25 * rate * 0.25
    const zN40 = n40 * rate * 0.4
    const gesamt = grund + zSo + zN25 + zN40
    return { sn: i + 1, d, e, rate, total, sunday, n25, n40, grund, zSo, zN25, zN40, gesamt }
  }), [drivers, data])

  const summe = berechnet.reduce((s, r) => s + r.gesamt, 0)

  async function erzeugen() {
    setBusy(true); setFehler(null)
    try {
      const rows = berechnet.map((r) => ({
        sn: r.sn,
        name: r.d.name,
        employeeNumber: r.d.employeeNumber,
        rate: r.rate,
        total: r.total,
        sunday: r.sunday,
        night25: r.n25,
        night40: r.n40,
        krank: r.e.krank,
        brutto: r.e.brutto,
        abmelden: r.e.abmelden,
      }))
      const res = await fetch('/api/dienstplan/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthLabel, companyName, rows }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Fehler beim Erzeugen')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Dienstplan_${monthLabel.replace(' ', '_')}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setFehler((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const feld = 'w-full rounded border border-border bg-transparent px-2 py-1 text-sm'
  const zahl = feld + ' text-right'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dienstplan erstellen</h1>
          <p className="text-sm text-textMuted">
            Monat wählen, je Fahrer Stunden &amp; Zuschläge eintragen → Dienstplan-Excel.
            Eingaben werden im Browser automatisch gespeichert.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-textMuted">Monat</span>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={feld}>
              {MONATE.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-textMuted">Jahr</span>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={feld}>
              {[now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          <button
            onClick={erzeugen}
            disabled={busy}
            className="rounded bg-text px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50"
          >
            {busy ? 'Erzeuge…' : 'Dienstplan-Excel erzeugen'}
          </button>
        </div>
      </div>

      {fehler && <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{fehler}</div>}

      {drivers.length === 0 ? (
        <div className="rounded border border-border p-8 text-center text-sm text-textMuted">
          Keine aktiven Fahrer. Lege zuerst unter „Fahrer" welche an.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-black/5 text-left text-xs uppercase text-textMuted">
                <th className="px-2 py-2">S/N</th>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2 text-right">€/Std</th>
                <th className="px-2 py-2 text-right">Gesamt Std</th>
                <th className="px-2 py-2 text-right">Sonntag 50%</th>
                <th className="px-2 py-2 text-right">Nacht 25%</th>
                <th className="px-2 py-2 text-right">Nacht 40%</th>
                <th className="px-2 py-2 text-right">Lohn gesamt</th>
                <th className="px-2 py-2">Krank</th>
                <th className="px-2 py-2">1 % Brutto</th>
                <th className="px-2 py-2">abmelden</th>
              </tr>
            </thead>
            <tbody>
              {berechnet.map((r) => (
                <tr key={r.d.id} className="border-b border-border last:border-0">
                  <td className="px-2 py-1 text-textMuted">{r.sn}</td>
                  <td className="whitespace-nowrap px-2 py-1 font-medium">
                    {r.d.name}
                    {r.d.employeeNumber && <span className="ml-1 text-xs text-textMuted">#{r.d.employeeNumber}</span>}
                  </td>
                  <td className="px-2 py-1 w-20"><input className={zahl} inputMode="decimal" value={r.e.rate} onChange={(e) => set(r.d.id, 'rate', e.target.value)} /></td>
                  <td className="px-2 py-1 w-20"><input className={zahl} inputMode="decimal" value={r.e.total} onChange={(e) => set(r.d.id, 'total', e.target.value)} /></td>
                  <td className="px-2 py-1 w-20"><input className={zahl} inputMode="decimal" value={r.e.sunday} onChange={(e) => set(r.d.id, 'sunday', e.target.value)} /></td>
                  <td className="px-2 py-1 w-20"><input className={zahl} inputMode="decimal" value={r.e.night25} onChange={(e) => set(r.d.id, 'night25', e.target.value)} /></td>
                  <td className="px-2 py-1 w-20"><input className={zahl} inputMode="decimal" value={r.e.night40} onChange={(e) => set(r.d.id, 'night40', e.target.value)} /></td>
                  <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{eur(r.gesamt)} €</td>
                  <td className="px-2 py-1 w-36"><input className={feld} value={r.e.krank} onChange={(e) => set(r.d.id, 'krank', e.target.value)} placeholder="z. B. 16.9.–20.9." /></td>
                  <td className="px-2 py-1 w-24"><input className={feld} value={r.e.brutto} onChange={(e) => set(r.d.id, 'brutto', e.target.value)} placeholder="Nein" /></td>
                  <td className="px-2 py-1 w-40"><input className={feld} value={r.e.abmelden} onChange={(e) => set(r.d.id, 'abmelden', e.target.value)} placeholder="z. B. ab Sept. Minijob" /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-black/5 font-semibold">
                <td className="px-2 py-2" colSpan={7}>Lohn gesamt (alle Fahrer)</td>
                <td className="px-2 py-2 text-right font-mono whitespace-nowrap">{eur(summe)} €</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-xs text-textMuted">
        <strong>Gesamt&nbsp;Std = bezahlte Stunden</strong> (Nettoarbeit + Pause; die Pause wird bezahlt, der Arbeitsweg zählt nie mit).
        Grundlohn = Gesamt&nbsp;Std × €/Std. Zuschläge stapeln on top: Sonntag +50 %, Nacht +25 % bzw. +40 %
        auf die jeweils eingetragenen Stunden. „Krank", „1 % Brutto" und „abmelden" sind reine Textvermerke.
        Der Stundenlohn ist je Zeile editierbar (für unterjährige Änderungen) – dauerhaft änderst du ihn im Fahrer-Datensatz.
      </p>
    </div>
  )
}
