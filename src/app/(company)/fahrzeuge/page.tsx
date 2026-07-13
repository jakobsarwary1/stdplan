import Link from 'next/link'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Badge, Button, Card } from '@/components/ui'

const STATUS_LABEL: Record<string, string> = {
  active: 'Aktiv',
  workshop: 'Werkstatt',
  out_of_service: 'Außer Betrieb',
  sold: 'Verkauft'
}
const STATUS_TONE: Record<string, 'success' | 'danger' | 'muted'> = {
  active: 'success',
  workshop: 'danger',
  out_of_service: 'danger',
  sold: 'muted'
}

export default async function VehiclesPage() {
  const user = await requireCompanyUser()

  const vehicles = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.vehicle.findMany({ orderBy: { createdAt: 'desc' } })
  )

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Fahrzeuge</h1>
        <Link href="/fahrzeuge/neu">
          <Button>+ Fahrzeug erfassen</Button>
        </Link>
      </div>

      {vehicles.length === 0 ? (
        <Card>
          <p className="text-textMuted">Noch keine Fahrzeuge erfasst.</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surfaceAlt text-left text-xs uppercase text-textMuted">
              <tr>
                <th className="px-4 py-3">Kennzeichen</th>
                <th className="px-4 py-3">Marke / Modell</th>
                <th className="px-4 py-3">Baujahr</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Kilometerstand</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id} className="table-row-clickable border-t border-border">
                  <td className="p-0 font-medium">
                    <Link href={`/fahrzeuge/${v.id}`} className="block px-4 py-3">{v.licensePlate}</Link>
                  </td>
                  <td className="p-0">
                    <Link href={`/fahrzeuge/${v.id}`} className="block px-4 py-3">
                      {[v.brand, v.model].filter(Boolean).join(' ') || '—'}
                    </Link>
                  </td>
                  <td className="p-0"><Link href={`/fahrzeuge/${v.id}`} className="block px-4 py-3">{v.year ?? '—'}</Link></td>
                  <td className="p-0">
                    <Link href={`/fahrzeuge/${v.id}`} className="block px-4 py-3">
                      <Badge tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Badge>
                    </Link>
                  </td>
                  <td className="p-0">
                    <Link href={`/fahrzeuge/${v.id}`} className="block px-4 py-3">
                      {v.mileage.toLocaleString('de-DE')} km
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
