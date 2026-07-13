'use server'

import { revalidatePath } from 'next/cache'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'

export async function addDemandProfile(formData: FormData) {
  const user = await requireCompanyUser()

  const weekday = parseInt(String(formData.get('weekday') ?? '1'), 10)
  const startTime = String(formData.get('startTime') ?? '').trim()
  const endTime = String(formData.get('endTime') ?? '').trim()
  const level = String(formData.get('level') ?? 'mittel').trim() as any

  if (!startTime || !endTime) throw new Error('Start- und Endzeit sind erforderlich.')

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.demandProfile.create({
      data: { companyId: user.companyId, weekday, startTime, endTime, level }
    })
  )

  revalidatePath('/einstellungen')
}

export async function deleteDemandProfile(profileId: string) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.demandProfile.delete({ where: { id: profileId } })
  )

  revalidatePath('/einstellungen')
}
