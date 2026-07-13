import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Badge, Button, Card, Field, Input } from '@/components/ui'
import { addDemandProfile, deleteDemandProfile } from './actions'

const WEEKDAYS = [
  { value: 1, label: 'Montag' }, { value: 2, label: 'Dienstag' }, { value: 3, label: 'Mittwoch' },
  { value: 4, label: 'Donnerstag' }, { value: 5, label: 'Freitag' }, { value: 6, label: 'Samstag' }, { value: 0, label: 'Sonntag' }
]
const LEVELS = [
  { value: 'niedrig', label: 'Niedrig' }, { value: 'mittel', label: 'Mittel' },
  { value: 'hoch', label: 'Hoch' }, { value: 'sehr_hoch', label: 'Sehr hoch' }
]
const LEVEL_TONE: Record<string, 'muted' | 'success' | 'danger'> = {
  niedrig: 'muted', mittel: 'muted', hoch: 'success', sehr_hoch: 'danger'
}

export default async function SettingsPage() {
  const user = await requireCompanyUser()

  const profiles = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.demandProfile.findMany({ orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] })
  )

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Einstellungen</h1>
      <h2 className="mb-1 mt-6 text-lg font-semibold">Nachfrageprofile</h2>
      <p className="mb-6 text-sm text-textMuted">
        Für jeden Wochentag beliebig viele Zeitfenster mit Nachfragestufe. Die Auto-Planung nutzt diese Profile,
        um bei „Nachfrage priorisieren" die wirtschaftlich sinnvollste Startzeit zu berechnen.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {WEEKDAYS.map((wd) => (
          <Card key={wd.value}>
            <h3 className="mb-3 font-semibold">{wd.label}</h3>
            <ul className="mb-4 space-y-2 text-sm">
              {profiles.filter((p) => p.weekday === wd.value).map((p) => {
                const remove = deleteDemandProfile.bind(null, p.id)
                return (
                  <li key={p.id} className="flex items-center justify-between">
                    <span className="font-mono">{p.startTime}–{p.endTime}</span>
                    <div className="flex items-center gap-2">
                      <Badge tone={LEVEL_TONE[p.level]}>{LEVELS.find((l) => l.value === p.level)?.label}</Badge>
                      <form action={remove}>
                        <button type="submit" className="text-xs text-danger hover:underline">×</button>
                      </form>
                    </div>
                  </li>
                )
              })}
              {profiles.filter((p) => p.weekday === wd.value).length === 0 && (
                <li className="text-textMuted">Keine Zeitfenster definiert.</li>
              )}
            </ul>

            <form action={addDemandProfile} className="flex items-end gap-2">
              <input type="hidden" name="weekday" value={wd.value} />
              <div className="field">
                <label className="label">Von</label>
                <Input name="startTime" type="time" required />
              </div>
              <div className="field">
                <label className="label">Bis</label>
                <Input name="endTime" type="time" required />
              </div>
              <div className="field">
                <label className="label">Nachfrage</label>
                <select name="level" className="input" defaultValue="mittel">
                  {LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              </div>
              <Button type="submit" className="shrink-0">+</Button>
            </form>
          </Card>
        ))}
      </div>
    </div>
  )
}
