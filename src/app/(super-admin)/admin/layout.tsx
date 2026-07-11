import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSuperAdmin } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSuperAdmin()

  return (
    <div className="min-h-screen">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div>
            <Link href="/admin" className="text-lg font-semibold">
              FleetOS <span className="text-textMuted font-normal">· Plattform-Administration</span>
            </Link>
          </div>
          <div className="flex items-center gap-4 text-sm text-textMuted">
            <span>{user.email}</span>
            <form action={async () => {
              'use server'
              const supabase = createClient()
              await supabase.auth.signOut()
              redirect('/login')
            }}>
              <button className="hover:text-text">Abmelden</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  )
}
