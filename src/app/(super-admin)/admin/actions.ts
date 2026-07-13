'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSuperAdmin } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { createAdminClient } from '@/lib/supabase/admin'
import { DEMAND_PROFILE_SEEDS, SHIFT_TEMPLATE_SEEDS } from '@/lib/seedDefaults'

export async function createCompany(formData: FormData) {
  await requireSuperAdmin()

  const name = String(formData.get('name') ?? '').trim()
  const address = String(formData.get('address') ?? '').trim() || null
  const taxId = String(formData.get('taxId') ?? '').trim() || null

  if (!name) throw new Error('Name des Unternehmens ist erforderlich.')

  const company = await withTenantContext({ companyId: null, isSuperAdmin: true }, async (tx) => {
    const created = await tx.company.create({
      data: {
        name,
        address,
        taxId,
        settings: { create: {} } // Firmeneinstellungen mit sinnvollen Standardwerten anlegen
      }
    })

    // Standard-Schichtmodelle + Nachfrageprofile seeden, damit der
    // Firmeninhaber sofort startklar ist (siehe Super-Prompt 5.6 / 5.8).
    for (const seed of SHIFT_TEMPLATE_SEEDS) {
      await tx.shiftTemplate.create({
        data: {
          companyId: created.id,
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

    await tx.demandProfile.createMany({
      data: DEMAND_PROFILE_SEEDS.map((d) => ({ ...d, companyId: created.id }))
    })

    return created
  })

  revalidatePath('/admin')
  redirect(`/admin/unternehmen/${company.id}`)
}

export async function setCompanyActive(companyId: string, active: boolean) {
  await requireSuperAdmin()

  await withTenantContext({ companyId: null, isSuperAdmin: true }, (tx) =>
    tx.company.update({ where: { id: companyId }, data: { active } })
  )

  revalidatePath('/admin')
  revalidatePath(`/admin/unternehmen/${companyId}`)
}

/**
 * Lädt einen neuen Firmeninhaber per E-Mail ein (Supabase Auth Invite-Mail)
 * und verknüpft ihn nach Registrierung mit dem Unternehmen als company_owner.
 * Setzt voraus, dass in Supabase eine "Redirect URL" für Einladungen
 * konfiguriert ist (Supabase Dashboard -> Authentication -> URL Configuration).
 */
export async function inviteCompanyOwner(companyId: string, formData: FormData) {
  await requireSuperAdmin()

  const email = String(formData.get('email') ?? '').trim()
  if (!email) throw new Error('E-Mail-Adresse ist erforderlich.')

  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email)

  if (error || !data.user) {
    throw new Error(`Einladung fehlgeschlagen: ${error?.message ?? 'unbekannter Fehler'}`)
  }

  await withTenantContext({ companyId: null, isSuperAdmin: true }, (tx) =>
    tx.companyMember.create({
      data: { companyId, userId: data.user!.id, role: 'company_owner' }
    })
  )

  revalidatePath(`/admin/unternehmen/${companyId}`)
}
