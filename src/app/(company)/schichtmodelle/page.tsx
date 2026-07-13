import Link from 'next/link'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Badge, Button, Card } from '@/components/ui'
import { seedDefaultsForExistingCompany } from './actions'

export default async function ShiftTemplatesPage() {
  const user = await requireCompanyUser()

  const templates = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplate.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { shifts: true, vehicles: true } } }
    })
  )

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Schichtmodelle</h1>
          <p className="text-sm text-textMuted">
            Definieren nur den Rahmen (Startfenster, Netto-Arbeitszeit) – die Auto-Planung berechnet daraus
            täglich die optimale Startzeit.
          </p>
        </div>
        <div className="flex gap-2">
          <form action={seedDefaultsForExistingCompany}>
            <Button type="submit" variant="ghost">Standardmodelle laden</Button>
          </form>
          <Link href="/schichtmodelle/neu">
            <Button>+ Modell erstellen</Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {templates.map((t) => (
          <Link key={t.id} href={`/schichtmodelle/${t.id}`}>
            <Card className="table-row-clickable h-full">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">{t.name}</h3>
                <div className="flex gap-2">
                  {t.singleDriverMode && <Badge tone="success">Stammfahrer</Badge>}
                  <Badge tone={t.active ? 'success' : 'muted'}>{t.active ? 'Aktiv' : 'Inaktiv'}</Badge>
                </div>
              </div>
              {t.description && <p className="mb-3 text-sm text-textMuted">{t.description}</p>}
              <p className="text-xs text-textMuted">
                {t.mode === 'flexible' ? 'Flexibel (nach Nachfrage)' : `${t._count.shifts} Schicht(en)`} ·{' '}
                {t._count.vehicles} Fahrzeug(e) zugewiesen
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
