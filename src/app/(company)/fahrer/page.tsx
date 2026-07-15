import Link from 'next/link'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Badge, Button, Card } from '@/components/ui'
import { stripEmployeeNumberPadding } from '@/lib/employeeNumber'

const EMPLOYMENT_LABEL: Record<string, string> = {
  fulltime: 'Vollzeit',
  parttime: 'Teilzeit',
  minijob: 'Minijob',
  shortterm: 'Kurzfristige Beschäftigung',
  workingStudent: 'Werkstudent',
  auxiliary: 'Aushilfe',
  freelancer: 'Freelancer / Selbstständig'
}
const STATUS_LABEL: Record<string, string> = { active: 'Aktiv', inactive: 'Inaktiv', terminated: 'Gekündigt' }
const STATUS_TONE: Record<string, 'success' | 'danger' | 'muted'> = { active: 'success', inactive: 'muted', terminated: 'danger' }

export default async function DriversPage() {
  const user = await requireCompanyUser()

  const drivers = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driver.findMany({ orderBy: { employeeNumber: 'asc' } })
  )

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Fahrer</h1>
        <Link href="/fahrer/neu">
          <Button>+ Fahrer erfassen</Button>
        </Link>
      </div>

      {drivers.length === 0 ? (
        <Card>
          <p className="text-textMuted">Noch keine Fahrer erfasst.</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surfaceAlt text-left text-xs uppercase text-textMuted">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Beschäftigungsart</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Personalnummer</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.id} className="table-row-clickable border-t border-border">
                  <td className="p-0 font-medium">
                    <Link href={`/fahrer/${d.id}`} className="block px-4 py-3">{d.firstName} {d.lastName}</Link>
                  </td>
                  <td className="p-0">
                    <Link href={`/fahrer/${d.id}`} className="block px-4 py-3">{EMPLOYMENT_LABEL[d.employmentType]}</Link>
                  </td>
                  <td className="p-0">
                    <Link href={`/fahrer/${d.id}`} className="block px-4 py-3">
                      <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                    </Link>
                  </td>
                  <td className="p-0">
                    <Link href={`/fahrer/${d.id}`} className="block px-4 py-3">{stripEmployeeNumberPadding(d.employeeNumber) || '—'}</Link>
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
