'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSuperAdmin } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { createAdminClient } from '@/lib/supabase/admin'

export async function createCompany(formData: FormData) {
  await requireSuperAdmin()

  const name = String(formData.get('name') ?? '').trim()
  const address = String(formData.get('address') ?? '').trim() || null
  const taxId = String(formData.get('taxId') ?? '').trim() || null

  if (!name) throw new Error('Name des Unternehmens ist erforderlich.')

  const company = await withTenantContext({ companyId: null, isSuperAdmin: true }, (tx) =>
    tx.company.create({
      data: {
        name,
        address,
        taxId,
        settings: { create: {} } // Firmeneinstellungen mit sinnvollen Standardwerten anlegen
      }
    })
  )

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
