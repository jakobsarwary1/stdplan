import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { stripEmployeeNumberPadding } from '@/lib/employeeNumber'
import StdplanForm from './StdplanForm'

export const dynamic = 'force-dynamic'

/** Personalnummer ohne Füll-Nullen, aber mind. 2-stellig: "000042" -> "42", "000001" -> "01". */
function persNr(raw: string | null | undefined): string {
  const s = stripEmployeeNumberPadding(raw)
  return /^\d+$/.test(s) ? s.padStart(2, '0') : s
}

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
    employeeNumber: persNr(d.employeeNumber),
    rate: d.hourlyRate ?? 13.9,
  }))

  return <StdplanForm drivers={rows} companyName={user.companyName ?? 'Firma Fly'} />
}
