import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Button, Card, Field, Input } from '@/components/ui'
import {
  addTemplateShift,
  deleteShiftTemplate,
  removeTemplateShift,
  updateShiftTemplate,
  updateTemplateShift
} from '../actions'

const WEEKDAYS = [
  { value: 1, label: 'Mo' }, { value: 2, label: 'Di' }, { value: 3, label: 'Mi' },
  { value: 4, label: 'Do' }, { value: 5, label: 'Fr' }, { value: 6, label: 'Sa' }, { value: 0, label: 'So' }
]

export default async function ShiftTemplateDetailPage({ params }: { params: { id: string } }) {
  const user = await requireCompanyUser()

  const template = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplate.findUnique({ where: { id: params.id }, include: { shifts: true } })
  )

  if (!template) notFound()

  const updateTemplate = updateShiftTemplate.bind(null, template.id)
  const removeTemplate = deleteShiftTemplate.bind(null, template.id)
  const addShift = addTemplateShift.bind(null, template.id)

  return (
    <div>
      <Link href="/schichtmodelle" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{template.name}</h1>
        <form action={removeTemplate}>
          <Button variant="ghost" type="submit" className="text-danger">Modell löschen</Button>
        </form>
      </div>

      <Card className="mb-6 max-w-xl">
        <h2 className="mb-4 font-semibold">Grundeinstellungen</h2>
        <form action={updateTemplate} className="space-y-4">
          <Field label="Name">
            <Input name="name" defaultValue={template.name} required />
          </Field>
          <Field label="Beschreibung">
            <Input name="description" defaultValue={template.description ?? ''} />
          </Field>
          <div className="field">
            <label className="label">Modus</label>
            <select name="mode" defaultValue={template.mode} className="input">
              <option value="fixed">Feste Schichten</option>
              <option value="flexible">Flexibel (nach Nachfrage, Fahrer-Modus)</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="active" defaultChecked={template.active} />
            Aktiv (in Fahrzeugen auswählbar)
          </label>
          <label className="flex items-center gap-2 text-sm" title="Fahrzeuge mit diesem Modell werden ausschließlich ihrem Stammfahrer zugewiesen.">
            <input type="checkbox" name="singleDriverMode" defaultChecked={template.singleDriverMode} />
            Fester Stammfahrer (kein täglicher Fahrerwechsel)
          </label>
          <Button type="submit">Speichern</Button>
        </form>
      </Card>

      {template.mode === 'flexible' ? (
        <Card className="max-w-xl">
          <p className="text-sm text-textMuted">
            Bei „Flexibel (nach Nachfrage)" werden keine festen Schichten hier hinterlegt.
          </p>
        </Card>
      ) : (
        <>
          <h2 className="mb-3 font-semibold">Schichten</h2>
          <div className="mb-6 space-y-4">
            {template.shifts.map((s) => (
              <ShiftForm
                key={s.id}
                action={updateTemplateShift.bind(null, template.id, s.id)}
                onRemove={removeTemplateShift.bind(null, template.id, s.id)}
                defaults={s}
              />
            ))}
          </div>

          <Card className="max-w-2xl">
            <h3 className="mb-4 font-semibold">Neue Schicht hinzufügen</h3>
            <ShiftForm action={addShift} submitLabel="Schicht hinzufügen" />
          </Card>
        </>
      )}
    </div>
  )
}

function ShiftForm({
  action,
  onRemove,
  defaults,
  submitLabel = 'Speichern'
}: {
  action: (formData: FormData) => Promise<void>
  onRemove?: (formData: FormData) => Promise<void>
  defaults?: {
    name: string
    driverCount: number
    weekdays: number[]
    requiredQualification: string | null
    earliestStart: string
    latestStart: string
    targetNetHours: number
    maxShiftHours: number
    flexibleStart: boolean
    prioritizeDemand: boolean
    optimizeNightSurcharge: boolean
    autoBreak: boolean
  }
  submitLabel?: string
}) {
  const d = defaults
  return (
    <Card>
      <form action={action} className="space-y-4">
        <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
          <Field label="Schichtname">
            <Input name="name" defaultValue={d?.name} required />
          </Field>
          <Field label="Fahreranzahl">
            <Input name="driverCount" type="number" min={1} defaultValue={d?.driverCount ?? 1} />
          </Field>
          <Field label="Qualifikation (optional)">
            <Input name="requiredQualification" defaultValue={d?.requiredQualification ?? ''} placeholder="z. B. krankenfahrten" />
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Field label="Frühester Beginn">
            <Input name="earliestStart" type="time" defaultValue={d?.earliestStart ?? '06:00'} required />
          </Field>
          <Field label="Spätester Beginn">
            <Input name="latestStart" type="time" defaultValue={d?.latestStart ?? '09:00'} required />
          </Field>
          <Field label="Netto-Arbeitszeit (Std.)">
            <Input name="targetNetHours" type="number" step="0.5" defaultValue={d?.targetNetHours ?? 8} />
          </Field>
          <Field label="Max. Schichtdauer (Std.)">
            <Input name="maxShiftHours" type="number" step="0.5" defaultValue={d?.maxShiftHours ?? 9} />
          </Field>
        </div>

        <div>
          <label className="label">Wochentage</label>
          <div className="flex gap-3">
            {WEEKDAYS.map((w) => (
              <label key={w.value} className="flex items-center gap-1 text-xs">
                <input type="checkbox" name={`weekday_${w.value}`} defaultChecked={d ? d.weekdays.includes(w.value) : true} />
                {w.label}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="flexibleStart" defaultChecked={d?.flexibleStart ?? true} />
            Flexibler Schichtbeginn
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="prioritizeDemand" defaultChecked={d?.prioritizeDemand ?? false} />
            Nachfrage priorisieren
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="optimizeNightSurcharge" defaultChecked={d?.optimizeNightSurcharge ?? false} />
            Nachtzuschläge optimieren
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="autoBreak" defaultChecked={d?.autoBreak ?? true} />
            Gesetzliche Pause automatisch
          </label>
        </div>

        <Button type="submit">{submitLabel}</Button>
      </form>
      {onRemove && (
        <form action={onRemove} className="mt-3 border-t border-border pt-3">
          <button type="submit" className="text-sm text-danger hover:underline">Schicht entfernen</button>
        </form>
      )}
    </Card>
  )
}
