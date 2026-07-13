'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { DEMAND_PROFILE_SEEDS, SHIFT_TEMPLATE_SEEDS } from '@/lib/seedDefaults'

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? '').trim()
  return v || null
}
function bool(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on'
}
function num(formData: FormData, key: string): number {
  return parseFloat(String(formData.get(key) ?? '0')) || 0
}
function weekdaysFrom(formData: FormData): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => formData.get(`weekday_${d}`) === 'on')
}

/**
 * Legt die Standard-Schichtmodelle + Nachfrageprofile nachträglich an -
 * für Unternehmen, die vor Einführung dieser Vorlagen angelegt wurden, oder
 * falls das automatische Seeding beim Anlegen fehlgeschlagen ist. Überspringt
 * bereits vorhandene Modelle mit gleichem Namen (kein Duplizieren bei
 * mehrfachem Klick).
 */
export async function seedDefaultsForExistingCompany() {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
    const existingTemplateNames = new Set(
      (await tx.shiftTemplate.findMany({ select: { name: true } })).map((t) => t.name)
    )

    for (const seed of SHIFT_TEMPLATE_SEEDS) {
      if (existingTemplateNames.has(seed.name)) continue
      await tx.shiftTemplate.create({
        data: {
          companyId: user.companyId,
          name: seed.name,
          description: seed.description,
          isDefault: seed.isDefault ?? false,
          singleDriverMode: seed.singleDriverMode ?? false,
          mode: seed.mode ?? 'fixed',
          shifts: {
            create: seed.shifts.map((s) => ({
              name: s.name,
              description: s.description,
              driverCount: s.driverCount ?? 1,
              weekdays: s.weekdays ?? [0, 1, 2, 3, 4, 5, 6],
              requiredQualification: s.requiredQualification,
              earliestStart: s.earliestStart,
              latestStart: s.latestStart,
              targetNetHours: s.targetNetHours,
              maxShiftHours: s.maxShiftHours,
              flexibleStart: s.flexibleStart ?? true,
              prioritizeDemand: s.prioritizeDemand ?? false,
              optimizeNightSurcharge: s.optimizeNightSurcharge ?? false,
              autoBreak: s.autoBreak ?? true
            }))
          }
        }
      })
    }

    const existingProfileCount = await tx.demandProfile.count()
    if (existingProfileCount === 0) {
      await tx.demandProfile.createMany({
        data: DEMAND_PROFILE_SEEDS.map((d) => ({ ...d, companyId: user.companyId }))
      })
    }
  })

  revalidatePath('/schichtmodelle')
  revalidatePath('/einstellungen')
}

export async function createShiftTemplate(formData: FormData) {
  const user = await requireCompanyUser()

  const name = str(formData, 'name')
  if (!name) throw new Error('Name ist erforderlich.')

  const template = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplate.create({
      data: {
        companyId: user.companyId,
        name,
        description: str(formData, 'description'),
        mode: 'fixed'
      }
    })
  )

  revalidatePath('/schichtmodelle')
  redirect(`/schichtmodelle/${template.id}`)
}

export async function updateShiftTemplate(templateId: string, formData: FormData) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplate.update({
      where: { id: templateId },
      data: {
        name: str(formData, 'name') ?? undefined,
        description: str(formData, 'description'),
        active: bool(formData, 'active'),
        singleDriverMode: bool(formData, 'singleDriverMode'),
        mode: (str(formData, 'mode') as any) ?? 'fixed'
      }
    })
  )

  revalidatePath(`/schichtmodelle/${templateId}`)
}

export async function deleteShiftTemplate(templateId: string) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplate.delete({ where: { id: templateId } })
  )

  revalidatePath('/schichtmodelle')
  redirect('/schichtmodelle')
}

export async function addTemplateShift(templateId: string, formData: FormData) {
  const user = await requireCompanyUser()

  const name = str(formData, 'name')
  if (!name) throw new Error('Name der Schicht ist erforderlich.')

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplateShift.create({
      data: {
        shiftTemplateId: templateId,
        name,
        driverCount: parseInt(String(formData.get('driverCount') ?? '1'), 10) || 1,
        weekdays: weekdaysFrom(formData),
        requiredQualification: str(formData, 'requiredQualification'),
        earliestStart: str(formData, 'earliestStart') ?? '06:00',
        latestStart: str(formData, 'latestStart') ?? '09:00',
        targetNetHours: num(formData, 'targetNetHours') || 8,
        maxShiftHours: num(formData, 'maxShiftHours') || 9,
        flexibleStart: bool(formData, 'flexibleStart'),
        prioritizeDemand: bool(formData, 'prioritizeDemand'),
        optimizeNightSurcharge: bool(formData, 'optimizeNightSurcharge'),
        autoBreak: bool(formData, 'autoBreak')
      }
    })
  )

  revalidatePath(`/schichtmodelle/${templateId}`)
}

export async function updateTemplateShift(templateId: string, shiftId: string, formData: FormData) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplateShift.update({
      where: { id: shiftId },
      data: {
        name: str(formData, 'name') ?? undefined,
        driverCount: parseInt(String(formData.get('driverCount') ?? '1'), 10) || 1,
        weekdays: weekdaysFrom(formData),
        requiredQualification: str(formData, 'requiredQualification'),
        earliestStart: str(formData, 'earliestStart') ?? '06:00',
        latestStart: str(formData, 'latestStart') ?? '09:00',
        targetNetHours: num(formData, 'targetNetHours') || 8,
        maxShiftHours: num(formData, 'maxShiftHours') || 9,
        flexibleStart: bool(formData, 'flexibleStart'),
        prioritizeDemand: bool(formData, 'prioritizeDemand'),
        optimizeNightSurcharge: bool(formData, 'optimizeNightSurcharge'),
        autoBreak: bool(formData, 'autoBreak')
      }
    })
  )

  revalidatePath(`/schichtmodelle/${templateId}`)
}

export async function removeTemplateShift(templateId: string, shiftId: string) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.shiftTemplateShift.delete({ where: { id: shiftId } })
  )

  revalidatePath(`/schichtmodelle/${templateId}`)
}
