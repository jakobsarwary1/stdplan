/**
 * Legt den allerersten Super-Admin an - notwendig, weil ohne einen
 * bestehenden Super-Admin niemand einen weiteren über die App-UI anlegen
 * könnte (Henne-Ei-Problem beim Erststart).
 *
 * Aufruf: SEED_SUPER_ADMIN_EMAIL=du@beispiel.de SEED_SUPER_ADMIN_PASSWORD=... npm run prisma:seed
 */
import { PrismaClient } from '@prisma/client'
import { createClient } from '@supabase/supabase-js'

const prisma = new PrismaClient()

async function main() {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD

  if (!email || !password) {
    throw new Error(
      'Bitte SEED_SUPER_ADMIN_EMAIL und SEED_SUPER_ADMIN_PASSWORD als Umgebungsvariablen setzen.'
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY müssen in .env gesetzt sein.')
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  // Nutzer anlegen (oder vorhandenen wiederverwenden, falls das Skript erneut läuft)
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

  await prisma.companyMember.upsert({
    where: { companyId_userId: { companyId: null, userId } },
    update: { role: 'super_admin' },
    create: { companyId: null, userId, role: 'super_admin' }
  })

  console.log(`✔ ${email} ist jetzt Super-Admin. Anmeldung unter /login.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
