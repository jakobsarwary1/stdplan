import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Card } from '@/components/ui'

export default async function DashboardPage() {
  const user = await requireCompanyUser()

  const [vehicleCount, driverCount] = await withTenantContext(
    { companyId: user.companyId, isSuperAdmin: false },
    async (tx) => [await tx.vehicle.count(), await tx.driver.count()]
  )

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Übersicht</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <Card>
          <p className="text-xs uppercase text-textMuted">Fahrzeuge</p>
          <p className="mt-2 text-2xl font-semibold">{vehicleCount}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-textMuted">Fahrer</p>
          <p className="mt-2 text-2xl font-semibold">{driverCount}</p>
        </Card>
      </div>
      <p className="mt-8 text-sm text-textMuted">
        Fahrzeug-, Fahrer- und Schichtverwaltung folgen in Phase 2–5 (siehe Super-Prompt Abschnitt 7).
      </p>
    </div>
  )
}
