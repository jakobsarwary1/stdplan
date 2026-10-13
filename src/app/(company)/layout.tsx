import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export default async function CompanyLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCompanyUser()

  return (
    <div className="min-h-screen">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/dienstplan" className="text-lg font-semibold">
            {user.companyName}
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/dienstplan" className="text-textMuted hover:text-text">Dienstplan</Link>
            <Link href="/fahrer" className="text-textMuted hover:text-text">Fahrer</Link>
          </nav>
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
