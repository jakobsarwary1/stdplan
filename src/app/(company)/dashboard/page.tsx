import Link from 'next/link'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { Card } from '@/components/ui'

export default async function DashboardPage() {
  const user = await requireCompanyUser()

  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  const monthLabel = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(monthStart)

  const [vehicleCount, driverCount, shiftCount, templateCount] = await withTenantContext(
    { companyId: user.companyId, isSuperAdmin: false },
    async (tx) => [
      await tx.vehicle.count({ where: { status: 'active' } }),
      await tx.driver.count({ where: { status: 'active' } }),
      await tx.shift.count({ where: { date: { gte: monthStart, lte: monthEnd } } }),
      await tx.shiftTemplate.count({ where: { active: true } })
    ]
  )

  const stats = [
    { label: 'Aktive Fahrzeuge', value: vehicleCount, href: '/fahrzeuge' },
    { label: 'Aktive Fahrer', value: driverCount, href: '/fahrer' },
    { label: 'Schichtmodelle', value: templateCount, href: '/schichtmodelle' },
    { label: `Schichten ${monthLabel}`, value: shiftCount, href: '/dienstplan' }
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Übersicht</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card className="transition-colors hover:border-accent">
              <p className="text-xs uppercase text-textMuted">{s.label}</p>
              <p className="mt-2 text-2xl font-semibold">{s.value}</p>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <h2 className="mb-2 font-semibold">Dienstplan erstellen</h2>
        <p className="mb-4 text-sm text-textMuted">
          Fahrzeugbasierte Auto-Planung aus den Schichtmodellen oder stundenbasierte Planung je Fahrer –
          inklusive Zuschlägen (§ 3b EStG) und Excel-Export.
        </p>
        <Link href="/dienstplan" className="btn btn-primary inline-block">Zum Dienstplan</Link>
      </Card>
    </div>
  )
}
