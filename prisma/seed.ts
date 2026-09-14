/**
 * Erststart-Seed für die EINE Firma: legt das Unternehmen, einen Firmen-Admin
 * (Login) sowie die Standard-Schichtmodelle und Nachfrageprofile an. stdplan
 * ist ein Ein-Firmen-Werkzeug zum Erstellen des Dienstplans - es gibt keinen
 * Super-Admin und keine Mehrmandanten-Verwaltung mehr.
 *
 * Aufruf:
 *   SEED_ADMIN_EMAIL=du@beispiel.de SEED_ADMIN_PASSWORD=EinSicheresPasswort \
 *   SEED_COMPANY_NAME="Meine Firma" npm run prisma:seed
 */
import { PrismaClient } from '@prisma/client'
import { createClient } from '@supabase/supabase-js'
import { SHIFT_TEMPLATE_SEEDS, DEMAND_PROFILE_SEEDS } from '../src/lib/seedDefaults'

const prisma = new PrismaClient()

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? process.env.SEED_SUPER_ADMIN_EMAIL
  const password = process.env.SEED_ADMIN_PASSWORD ?? process.env.SEED_SUPER_ADMIN_PASSWORD
  const companyName = process.env.SEED_COMPANY_NAME ?? 'Meine Firma'

  if (!email || !password) {
    throw new Error('Bitte SEED_ADMIN_EMAIL und SEED_ADMIN_PASSWORD als Umgebungsvariablen setzen.')
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY müssen in .env gesetzt sein.')
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  // Auth-Nutzer anlegen (oder vorhandenen wiederverwenden, falls erneut ausgeführt).
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  })

  let userId = created?.user?.id
  if (createError) {
    const { data: list, error: listError } = await admin.auth.admin.listUsers()
    if (listError) throw listError
    const existing = list.users.find((u) => u.email === email)
    if (!existing) throw createError
    userId = existing.id
    console.log(`Nutzer ${email} existiert bereits, verwende bestehenden Account.`)
  }
  if (!userId) throw new Error('Konnte keine Nutzer-ID ermitteln.')

  await prisma.$transaction(async (tx) => {
    // Erhöhter RLS-Kontext NUR für diesen Seed-Lauf (siehe
    // supabase/migrations/0001_rls_policies.sql) - beim allerersten Start
    // existiert noch keine Firmenzuordnung, gegen die die Policies prüfen
    // könnten (Henne-Ei-Problem).
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_company_id', '', true), set_config('app.is_super_admin', 'true', true)`
    )

    // Genau EINE Firma: bestehende wiederverwenden, sonst anlegen.
    const company = (await tx.company.findFirst()) ?? (await tx.company.create({ data: { name: companyName } }))

    // Admin-Zuordnung (idempotent).
    const membership = await tx.companyMember.findFirst({ where: { userId: userId! } })
    if (membership) {
      await tx.companyMember.update({ where: { id: membership.id }, data: { companyId: company.id, role: 'company_owner' } })
    } else {
      await tx.companyMember.create({ data: { companyId: company.id, userId: userId!, role: 'company_owner' } })
    }

    // Firmen-Einstellungen sicherstellen.
    await tx.companySettings.upsert({
      where: { companyId: company.id },
      update: {},
      create: { companyId: company.id }
    })

    // Standard-Schichtmodelle + Nachfrageprofile nur beim ersten Mal anlegen.
    const templateCount = await tx.shiftTemplate.count({ where: { companyId: company.id } })
    if (templateCount === 0) {
      for (const t of SHIFT_TEMPLATE_SEEDS) {
        await tx.shiftTemplate.create({
          data: {
            companyId: company.id,
            name: t.name,
            description: t.description,
            isDefault: t.isDefault ?? false,
            singleDriverMode: t.singleDriverMode ?? false,
            mode: t.mode ?? 'fixed',
            shifts: {
              create: t.shifts.map((s) => ({
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

      for (const p of DEMAND_PROFILE_SEEDS) {
        await tx.demandProfile.create({
          data: { companyId: company.id, weekday: p.weekday, startTime: p.startTime, endTime: p.endTime, level: p.level }
        })
      }
      console.log(`✔ Standard-Schichtmodelle (${SHIFT_TEMPLATE_SEEDS.length}) und Nachfrageprofile angelegt.`)
    }

    console.log(`✔ Firma „${company.name}" bereit, ${email} ist Firmen-Admin. Anmeldung unter /login.`)
  })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
