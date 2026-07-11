import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Nutzt den Service-Role-Key - hat vollen Zugriff und UMGEHT jede RLS-Policy.
 * NIEMALS in Client-Komponenten importieren, NIEMALS den Key an den Browser
 * senden. Ausschließlich in Server Actions / Route Handlern verwenden, z. B.
 * um neue Nutzer per E-Mail einzuladen (auth.admin.inviteUserByEmail).
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}
