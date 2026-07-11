import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Supabase-Client für Server Components, Server Actions und Route Handler.
 * Liest/schreibt die Auth-Session über Next.js-Cookies. In Server Components
 * selbst dürfen Cookies nicht geschrieben werden (Next.js-Beschränkung) -
 * das eigentliche Aktualisieren der Session übernimmt die Middleware
 * (siehe src/middleware.ts).
 */
export function createClient() {
  const cookieStore = cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options })
          } catch {
            // Aufruf aus einer Server Component - wird von der Middleware übernommen
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options })
          } catch {
            // Aufruf aus einer Server Component - wird von der Middleware übernommen
          }
        }
      }
    }
  )
}
