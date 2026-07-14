'use server'

import { revalidatePath } from 'next/cache'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'

export type ConfirmationField = 'tipsConfirmed' | 'expensesConfirmed' | 'timesheetConfirmed' | 'cashWageConfirmed'

/**
 * Schaltet eine einzelne monatliche Bestätigung (Trinkgeld, Spesen,
 * Stundenzettel, Lohnbestätigung) für einen Fahrer um - legt bei Bedarf
 * automatisch den Monatsdatensatz an (upsert).
 */
export async function toggleMonthlyConfirmation(formData: FormData) {
  const user = await requireCompanyUser()
  const driverId = String(formData.get('driverId') ?? '')
  const year = parseInt(String(formData.get('year') ?? ''), 10)
  const month = parseInt(String(formData.get('month') ?? ''), 10)
  const field = String(formData.get('field') ?? '') as ConfirmationField
  const nextValue = String(formData.get('nextValue') ?? '') === 'true'

  if (!driverId || !year || !month) return
  const validFields: ConfirmationField[] = ['tipsConfirmed', 'expensesConfirmed', 'timesheetConfirmed', 'cashWageConfirmed']
  if (!validFields.includes(field)) return

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driverMonthlyConfirmation.upsert({
      where: { driverId_year_month: { driverId, year, month } },
      update: { [field]: nextValue, confirmedAt: nextValue ? new Date() : null },
      create: {
        driverId,
        year,
        month,
        [field]: nextValue,
        confirmedAt: nextValue ? new Date() : null
      }
    })
  )

  revalidatePath('/dashboard')
}
