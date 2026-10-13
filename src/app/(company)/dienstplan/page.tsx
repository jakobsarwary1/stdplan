import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import StdplanForm from './StdplanForm'

export const dynamic = 'force-dynamic'

export default async function DienstplanPage() {
  const user = await requireCompanyUser()

  const drivers = await withTenantContext(
    { companyId: user.companyId, isSuperAdmin: false },
    (tx) =>
      tx.driver.findMany({
        where: { status: 'active' },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        select: { id: true, firstName: true, lastName: true, employeeNumber: true, hourlyRate: true },
      })
  )

  const rows = drivers.map((d) => ({
    id: d.id,
    name: `${d.firstName} ${d.lastName}`.trim(),
    employeeNumber: d.employeeNumber ?? '',
    rate: d.hourlyRate ?? 13.9,
  }))

  return <StdplanForm drivers={rows} companyName={user.companyName ?? 'Firma Fly'} />
}
