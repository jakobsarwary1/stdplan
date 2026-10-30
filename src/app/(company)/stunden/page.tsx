'use client'

import { useEffect, useMemo, useState } from 'react'
import { ladeMonate, loescheMonat, maxArbeitsSonntage, sonntageImJahr, MIN_FREIE_SONNTAGE, type MonatEintrag } from '../dienstplan/stundenStore'

const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
const METRIKEN = [
  { key: 'worked', label: 'Bezahlte Stunden (gefahren)' },
  { key: 'sonntag', label: 'Sonntag 50 %' },
  { key: 'nacht25', label: 'Nacht 25 %' },
  { key: 'nacht40', label: 'Nacht 40 %' },
  { key: 'feiertag', label: 'Feiertag 125 %' },
  { key: 'krank', label: 'Krank' },
] as const
type Metrik = typeof METRIKEN[number]['key']

const n1 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function StundenUebersicht() {
  const [monate, setMonate] = useState<MonatEintrag[]>([])
  const [jahr, setJahr] = useState<number>(new Date().getFullYear())
  const [metrik, setMetrik] = useState<Metrik>('worked')
  useEffect(() => { setMonate(ladeMonate()) }, [])

  const jahre = useMemo(() => {
    const s = new Set(monate.map((m) => Number(m.month.slice(0, 4))))
    s.add(new Date().getFullYear())
    return [...s].sort((a, b) => b - a)
  }, [monate])

  const desJahres = useMemo(() => monate.filter((m) => m.month.startsWith(String(jahr))), [monate, jahr])
  const fahrer = useMemo(() => [...new Set(desJahres.map((m) => m.name))].sort((a, b) => a.localeCompare(b)), [desJahres])
  const wert = (e: MonatEintrag | undefined): number => e ? (e[metrik] as number) : 0
  const maxSo = maxArbeitsSonntage(jahr)

  const entfernen = (month: string, name: string) => { loescheMonat(month, name); setMonate(ladeMonate()) }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Stundenübersicht</h1>
          <p className="text-sm text-textMuted">Monatliche bezahlte Stunden je Fahrer und das gesetzliche Sonntags-Budget (§ 11 ArbZG).</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-textMuted">Jahr</span>
            <select value={jahr} onChange={(e) => setJahr(Number(e.target.value))}
              className="rounded-lg border border-border bg-bg px-2 py-1 outline-none focus:border-accent">
              {jahre.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-textMuted">Anzeige</span>
            <select value={metrik} onChange={(e) => setMetrik(e.target.value as Metrik)}
              className="rounded-lg border border-border bg-bg px-2 py-1 outline-none focus:border-accent">
              {METRIKEN.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
        </div>
      </div>

      {desJahres.length === 0 ? (
        <div className="card text-sm text-textMuted">
          Für {jahr} sind noch keine Stunden gespeichert. Erstelle im <a href="/dienstplan" className="text-accent underline">Dienstplan</a> Stundenzettel –
          die Monatszahlen werden dann hier automatisch gesammelt. (v1: im Browser gespeichert.)
        </div>
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-textMuted">
                  <th className="px-2 py-1 font-medium">Fahrer</th>
                  {MONATE.map((m) => <th key={m} className="px-2 py-1 text-right font-medium">{m}</th>)}
                  <th className="px-2 py-1 text-right font-semibold">Σ Jahr</th>
                </tr>
              </thead>
              <tbody>
                {fahrer.map((name) => {
                  const zeile = desJahres.filter((m) => m.name === name)
                  const summe = zeile.reduce((a, e) => a + wert(e), 0)
                  return (
                    <tr key={name} className="border-t border-border/60">
                      <td className="whitespace-nowrap px-2 py-1">{name}</td>
                      {MONATE.map((_, i) => {
                        const mm = `${jahr}-${String(i + 1).padStart(2, '0')}`
                        const e = zeile.find((x) => x.month === mm)
                        const v = wert(e)
                        return (
                          <td key={i} className="px-2 py-1 text-right tabular-nums" title={e ? `${mm} · ${name}` : ''}>
                            {e ? <span className="group relative">{n1(v)}
                              <button onClick={() => entfernen(mm, name)} title="Monat löschen"
                                className="ml-1 hidden text-textMuted hover:text-red-500 group-hover:inline">✕</button>
                            </span> : <span className="text-textMuted/40">–</span>}
                          </td>
                        )
                      })}
                      <td className="px-2 py-1 text-right font-semibold tabular-nums">{n1(summe)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2 className="mb-1 text-sm font-semibold">Sonntags-Budget {jahr} (§ 11 ArbZG)</h2>
            <p className="mb-3 text-xs text-textMuted">
              Mindestens {MIN_FREIE_SONNTAGE} Sonntage im Jahr müssen frei bleiben. {jahr} hat {sonntageImJahr(jahr)} Sonntage →
              höchstens <span className="font-medium text-text">{maxSo}</span> Arbeits-Sonntage je Fahrer.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-textMuted">
                  <th className="px-2 py-1 font-medium">Fahrer</th>
                  <th className="px-2 py-1 text-right font-medium">Sonntage gearbeitet</th>
                  <th className="px-2 py-1 text-right font-medium">noch erlaubt</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {fahrer.map((name) => {
                  const so = desJahres.filter((m) => m.name === name).reduce((a, e) => a + (e.sundaysWorked || 0), 0)
                  const uebrig = maxSo - so
                  const farbe = uebrig <= 0 ? 'text-red-500' : uebrig <= 4 ? 'text-yellow-500' : 'text-green-500'
                  const text = uebrig <= 0 ? '✗ Limit erreicht' : uebrig <= 4 ? '⚠ fast aufgebraucht' : '✓ ok'
                  return (
                    <tr key={name} className="border-t border-border/60">
                      <td className="whitespace-nowrap px-2 py-1">{name}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{so}</td>
                      <td className={`px-2 py-1 text-right font-semibold tabular-nums ${farbe}`}>{Math.max(0, uebrig)}</td>
                      <td className={`px-2 py-1 ${farbe}`}>{text}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
