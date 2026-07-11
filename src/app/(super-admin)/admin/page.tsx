import Link from 'next/link'
import { requireSuperAdmin } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Badge, Button, Card } from '@/components/ui'

export default async function AdminCompaniesPage() {
  await requireSuperAdmin()

  const companies = await withTenantContext({ companyId: null, isSuperAdmin: true }, (tx) =>
    tx.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { members: true, vehicles: true, drivers: true } } }
    })
  )

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Unternehmen</h1>
        <Link href="/admin/unternehmen/neu">
          <Button>+ Unternehmen anlegen</Button>
        </Link>
      </div>

      {companies.length === 0 ? (
        <Card>
          <p className="text-textMuted">Noch keine Unternehmen angelegt.</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surfaceAlt text-left text-xs uppercase text-textMuted">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Mitglieder</th>
                <th className="px-4 py-3">Fahrzeuge</th>
                <th className="px-4 py-3">Fahrer</th>
                <th className="px-4 py-3">Angelegt</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="table-row-clickable border-t border-border">
                  <td className="p-0 font-medium">
                    <Link href={`/admin/unternehmen/${c.id}`} className="block px-4 py-3">{c.name}</Link>
                  </td>
                  <td className="p-0">
                    <Link href={`/admin/unternehmen/${c.id}`} className="block px-4 py-3">
                      <Badge tone={c.active ? 'success' : 'danger'}>{c.active ? 'Aktiv' : 'Deaktiviert'}</Badge>
                    </Link>
                  </td>
                  <td className="p-0"><Link href={`/admin/unternehmen/${c.id}`} className="block px-4 py-3">{c._count.members}</Link></td>
                  <td className="p-0"><Link href={`/admin/unternehmen/${c.id}`} className="block px-4 py-3">{c._count.vehicles}</Link></td>
                  <td className="p-0"><Link href={`/admin/unternehmen/${c.id}`} className="block px-4 py-3">{c._count.drivers}</Link></td>
                  <td className="p-0">
                    <Link href={`/admin/unternehmen/${c.id}`} className="block px-4 py-3 text-textMuted">
                      {new Intl.DateTimeFormat('de-DE').format(c.createdAt)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
