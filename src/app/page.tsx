import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'

export default async function HomePage() {
  const user = await requireUser()

  if (user.role === 'super_admin') redirect('/admin')
  redirect('/dashboard')
}
