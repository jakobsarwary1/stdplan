import { PrismaClient } from '@prisma/client'

// Next.js lädt Module im Dev-Modus bei jedem Hot-Reload neu - ohne diesen
// Cache auf `globalThis` würden dabei immer neue Datenbankverbindungen
// aufgebaut, bis das Limit erschöpft ist.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export type TenantContext = {
  companyId: string | null
  isSuperAdmin: boolean
}

/**
 * Führt eine Datenbankoperation im Kontext eines bestimmten Unternehmens aus.
 * Setzt vor der eigentlichen Abfrage die Postgres-Session-Variablen
 * `app.current_company_id` / `app.is_super_admin`, gegen die die
 * Row-Level-Security-Policies aus supabase/migrations/0001_rls_policies.sql
 * prüfen. `set_config(..., true)` gilt nur für die aktuelle Transaktion -
 * deshalb MUSS die eigentliche Abfrage innerhalb derselben `$transaction`
 * laufen, sonst greift die Isolation nicht.
 *
 * WICHTIG: Diese Funktion ist die EINZIGE vorgesehene Art, wie Anwendungscode
 * auf mandantenspezifische Daten zugreifen darf. Niemals `prisma.vehicle...`
 * o. ä. direkt außerhalb dieser Funktion aufrufen - sonst greift weder die
 * Mandantenprüfung im Code noch die RLS-Session-Variable.
 */
export async function withTenantContext<T>(
  context: TenantContext,
  fn: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_company_id', $1, true), set_config('app.is_super_admin', $2, true)`,
      context.companyId ?? '',
      context.isSuperAdmin ? 'true' : 'false'
    )
    return fn(tx)
  })
}
