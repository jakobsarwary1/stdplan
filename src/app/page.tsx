import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'

export default async function HomePage() {
  await requireUser()
  redirect('/dienstplan')
}
