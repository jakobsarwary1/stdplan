import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'

export type CurrentUser = {
  id: string
  email: string | null
  companyId: string | null
  role: 'super_admin' | 'company_owner' | 'dispatcher' | 'driver'
  companyName: string | null
}

/**
 * Ermittelt den eingeloggten Supabase-Auth-Nutzer und dessen Rolle/Unternehmen
 * aus company_members. Wirft KEINEN Fehler bei fehlendem Login - gibt null
 * zurück (Middleware kümmert sich bereits um die Weiterleitung zu /login;
 * diese Funktion ist für Fälle gedacht, in denen zusätzlich die Rolle
 * gebraucht wird).
 *
 * Hinweis: Diese Abfrage läuft bewusst NICHT über withTenantContext, da wir
 * hier erst herausfinden, WELCHES Unternehmen überhaupt gilt - das wäre ein
 * Henne-Ei-Problem. company_members hat eine eigene RLS-Policy, die auf
 * userId statt companyId prüft (siehe unten). Für den produktiven Einsatz:
 * diese eine Abfrage läuft privilegiert (Service-Role-Kontext), alle
 * NACHFOLGENDEN Abfragen dagegen strikt über withTenantContext.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = createClient()
  const {
    data: { user }
  } = await supabase.auth.getUser()

  if (!user) return null

  const membership = await prisma.companyMember.findFirst({
    where: { userId: user.id },
    include: { company: true }
  })

  if (!membership) return null

  return {
    id: user.id,
    email: user.email ?? null,
    companyId: membership.companyId,
    role: membership.role,
    companyName: membership.company?.name ?? null
  }
}

/** Wie getCurrentUser(), leitet aber zu /login weiter statt null zurückzugeben. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

/** Wie requireUser(), verlangt zusätzlich die Rolle super_admin. */
export async function requireSuperAdmin(): Promise<CurrentUser> {
  const user = await requireUser()
  if (user.role !== 'super_admin') redirect('/')
  return user
}

/** Wie requireUser(), verlangt eine bestehende Unternehmenszuordnung (kein Super-Admin). */
export async function requireCompanyUser(): Promise<CurrentUser & { companyId: string }> {
  const user = await requireUser()
  if (!user.companyId) redirect('/admin')
  return user as CurrentUser & { companyId: string }
}
