import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSuperAdmin } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Badge, Button, Card, Field, Input } from '@/components/ui'
import { inviteCompanyOwner, setCompanyActive } from '../../actions'

export default async function CompanyDetailPage({ params }: { params: { id: string } }) {
  await requireSuperAdmin()

  const company = await withTenantContext({ companyId: null, isSuperAdmin: true }, (tx) =>
    tx.company.findUnique({
      where: { id: params.id },
      include: { members: true, _count: { select: { vehicles: true, drivers: true } } }
    })
  )

  if (!company) notFound()

  const toggleActive = setCompanyActive.bind(null, company.id, !company.active)
  const invite = inviteCompanyOwner.bind(null, company.id)

  return (
    <div>
      <Link href="/admin" className="mb-4 inline-block text-sm text-textMuted hover:text-text">
        ← Zurück zur Übersicht
      </Link>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{company.name}</h1>
          <p className="text-sm text-textMuted">
            Angelegt am {new Intl.DateTimeFormat('de-DE').format(company.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={company.active ? 'success' : 'danger'}>{company.active ? 'Aktiv' : 'Deaktiviert'}</Badge>
          <form action={toggleActive}>
            <Button variant="ghost" type="submit">
              {company.active ? 'Deaktivieren' : 'Aktivieren'}
            </Button>
          </form>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <h2 className="mb-4 font-semibold">Stammdaten</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-textMuted">Adresse</dt>
              <dd>{company.address || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-textMuted">Steuernummer</dt>
              <dd>{company.taxId || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-textMuted">Fahrzeuge</dt>
              <dd>{company._count.vehicles}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-textMuted">Fahrer</dt>
              <dd>{company._count.drivers}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-4 font-semibold">Mitglieder</h2>
          {company.members.length === 0 ? (
            <p className="mb-4 text-sm text-textMuted">Noch kein Firmeninhaber eingeladen.</p>
          ) : (
            <ul className="mb-4 space-y-2 text-sm">
              {company.members.map((m) => (
                <li key={m.id} className="flex justify-between border-b border-border pb-2 last:border-0">
                  <span className="text-textMuted">{m.userId}</span>
                  <Badge>{m.role}</Badge>
                </li>
              ))}
            </ul>
          )}

          <form action={invite} className="flex gap-2">
            <Field label="Firmeninhaber per E-Mail einladen">
              <Input type="email" name="email" required placeholder="inhaber@beispiel.de" />
            </Field>
            <Button type="submit" className="mt-6 shrink-0">
              Einladen
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
