'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { useMemo, useState } from 'react'
import { Badge, Button, Card } from '@/components/ui'
import { applyAutoPlanning, previewAutoPlanning, type PlanningPreviewState } from './actions'
import { fmtDateDEWithWeekday, formatBreakRanges, minToClock } from '@/lib/planning/format'

const INITIAL_STATE: PlanningPreviewState = { slots: [], skipped: [], skippedVehicles: [], error: null }

function PreviewSubmit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Berechne…' : 'Schichten erzeugen & Fahrer zuweisen'}
    </Button>
  )
}

export function AutoPlanningForm({
  vehicles,
  defaultStart,
  defaultEnd
}: {
  vehicles: { id: string; licensePlate: string; hasTemplate: boolean }[]
  defaultStart: string
  defaultEnd: string
}) {
  const [state, formAction] = useFormState(previewAutoPlanning, INITIAL_STATE)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const assignedCount = useMemo(() => state.slots.filter((s) => !s.conflict).length, [state.slots])
  const conflictCount = state.slots.length - assignedCount

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      <Card className="mb-6">
        <h2 className="mb-4 font-semibold">Auto-Planung</h2>
        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="field">
              <label className="label">Zeitraum von</label>
              <input type="date" name="startDate" defaultValue={defaultStart} className="input" required />
            </div>
            <div className="field">
              <label className="label">Zeitraum bis</label>
              <input type="date" name="endDate" defaultValue={defaultEnd} className="input" required />
            </div>
          </div>

          <div>
            <label className="label">Fahrzeuge</label>
            <div className="flex flex-wrap gap-2">
              {vehicles.map((v) => (
                <label
                  key={v.id}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    selected.has(v.id) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-textMuted'
                  } ${!v.hasTemplate ? 'opacity-50' : 'cursor-pointer'}`}
                >
                  <input
                    type="checkbox" name="vehicleIds" value={v.id} className="mr-1.5"
                    checked={selected.has(v.id)}
                    onChange={() => toggle(v.id)}
                    disabled={!v.hasTemplate}
                  />
                  {v.licensePlate}{!v.hasTemplate && ' (kein Schichtmodell)'}
                </label>
              ))}
            </div>
          </div>

          <PreviewSubmit />
        </form>

        {state.error && <p className="mt-4 text-sm text-danger">{state.error}</p>}
      </Card>

      {state.slots.length > 0 && (
        <div>
          <div className="mb-4 flex gap-3">
            <Badge tone="success">{assignedCount} Schichten zugewiesen</Badge>
            {conflictCount > 0 && <Badge tone="danger">{conflictCount} Konflikt(e)</Badge>}
          </div>

          {state.skippedVehicles.length > 0 && (
            <Card className="mb-4">
              <h3 className="mb-2 text-sm font-semibold">Übersprungene Fahrzeuge</h3>
              {state.skippedVehicles.map((s, i) => (
                <p key={i} className="text-sm text-textMuted">{s.vehiclePlate}: {s.reason}</p>
              ))}
            </Card>
          )}

          {conflictCount > 0 && (
            <Card className="mb-4">
              <h3 className="mb-2 text-sm font-semibold text-danger">Konflikte (kein Fahrer verfügbar)</h3>
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-textMuted">
                  <tr><th className="pb-2">Fahrzeug</th><th className="pb-2">Datum</th><th className="pb-2">Schicht</th><th className="pb-2">Grund</th></tr>
                </thead>
                <tbody>
                  {state.slots.filter((s) => s.conflict).map((s, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-2 font-mono">{s.vehiclePlate}</td>
                      <td className="py-2 font-mono">{fmtDateDEWithWeekday(s.date)}</td>
                      <td className="py-2">{s.shiftName}</td>
                      <td className="py-2 text-textMuted">{s.conflictReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card className="mb-4">
            <h3 className="mb-2 text-sm font-semibold">Zugewiesene Schichten</h3>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-textMuted">
                <tr>
                  <th className="pb-2">Fahrer</th><th className="pb-2">Datum</th>
                  <th className="pb-2">Von</th><th className="pb-2">Bis</th><th className="pb-2">Pause</th><th className="pb-2">Fahrzeug</th>
                </tr>
              </thead>
              <tbody>
                {state.slots.filter((s) => !s.conflict).map((s, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-2 font-medium">
                      {s.driverName}
                      {s.isSubstitute && <span className="ml-2 text-xs text-accent">(Vertretung für {s.primaryDriverName})</span>}
                    </td>
                    <td className="py-2 font-mono">{fmtDateDEWithWeekday(s.date)}</td>
                    <td className="py-2 font-mono">{minToClock(s.startMin)}</td>
                    <td className="py-2 font-mono">{minToClock(s.endMin)}</td>
                    <td className="py-2 font-mono">{formatBreakRanges(s.startMin, s.breaks)}</td>
                    <td className="py-2 font-mono">{s.vehiclePlate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <form action={applyAutoPlanning}>
            <input type="hidden" name="slotsJson" value={JSON.stringify(state.slots)} />
            <Button type="submit">Zugewiesene Schichten übernehmen</Button>
          </form>
        </div>
      )}
    </div>
  )
}
