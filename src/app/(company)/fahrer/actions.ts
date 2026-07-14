'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { uploadDocument } from '@/lib/storage'

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? '').trim()
  return v || null
}

function date(formData: FormData, key: string): Date | null {
  const v = str(formData, key)
  return v ? new Date(v) : null
}

export async function createDriver(formData: FormData) {
  const user = await requireCompanyUser()

  const firstName = str(formData, 'firstName')
  const lastName = str(formData, 'lastName')
  if (!firstName || !lastName) throw new Error('Vor- und Nachname sind erforderlich.')

  const driver = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driver.create({
      data: {
        companyId: user.companyId,
        firstName,
        lastName,
        phone: str(formData, 'phone'),
        email: str(formData, 'email')
      }
    })
  )

  revalidatePath('/fahrer')
  redirect(`/fahrer/${driver.id}`)
}

export async function updateDriverPersoenlich(driverId: string, formData: FormData) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driver.update({
      where: { id: driverId },
      data: {
        firstName: str(formData, 'firstName') ?? undefined,
        lastName: str(formData, 'lastName') ?? undefined,
        birthDate: date(formData, 'birthDate'),
        birthPlace: str(formData, 'birthPlace'),
        street: str(formData, 'street'),
        houseNumber: str(formData, 'houseNumber'),
        postalCode: str(formData, 'postalCode'),
        city: str(formData, 'city'),
        phone: str(formData, 'phone'),
        email: str(formData, 'email')
      }
    })
  )

  revalidatePath(`/fahrer/${driverId}`)
  redirect(`/fahrer/${driverId}?tab=persoenlich&saved=1`)
}

export async function updateDriverBeschaeftigung(driverId: string, formData: FormData) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driver.update({
      where: { id: driverId },
      data: {
        employmentType: (str(formData, 'employmentType') as any) ?? 'fulltime',
        status: (str(formData, 'status') as any) ?? 'active',
        employeeNumber: str(formData, 'employeeNumber'),
        hireDate: date(formData, 'hireDate'),
        socialSecurityNumber: str(formData, 'socialSecurityNumber'),
        healthInsuranceProvider: str(formData, 'healthInsuranceProvider'),
        taxId: str(formData, 'taxId'),
        licenseClass: str(formData, 'licenseClass'),
        licenseNumber: str(formData, 'licenseNumber')?.toUpperCase() ?? null,
        licenseExpiry: date(formData, 'licenseExpiry'),
        pbeScheinNumber: str(formData, 'pbeScheinNumber'),
        pbeScheinExpiry: date(formData, 'pbeScheinExpiry'),
        hourlyRate: (() => {
          const raw = str(formData, 'hourlyRate')
          if (!raw) return null
          // Deutsches Komma als Dezimaltrennzeichen zulassen (z. B. "13,90"),
          // nicht nur den englischen Punkt.
          const parsed = parseFloat(raw.replace(',', '.'))
          if (Number.isNaN(parsed)) return null
          // Gesetzlicher Mindestlohn 2026: 13,90 €/Std. - unterhalb davon
          // wäre die Eingabe rechtswidrig. Obergrenze 30 € als Plausibilitäts-
          // Deckel gegen Tippfehler (kann bei Bedarf angepasst werden).
          const MINDESTLOHN_2026 = 13.9
          const MAX_HOURLY_RATE = 30.0
          return Math.min(MAX_HOURLY_RATE, Math.max(MINDESTLOHN_2026, parsed))
        })()
      }
    })
  )

  revalidatePath(`/fahrer/${driverId}`)
  redirect(`/fahrer/${driverId}?tab=beschaeftigung&saved=1`)
}

export async function deleteDriver(driverId: string) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driver.delete({ where: { id: driverId } })
  )

  revalidatePath('/fahrer')
  redirect('/fahrer')
}

export async function uploadDriverDocument(driverId: string, formData: FormData) {
  const user = await requireCompanyUser()

  const file = formData.get('file') as File | null
  const type = str(formData, 'type')
  const side = str(formData, 'side')
  if (!file || file.size === 0) throw new Error('Bitte eine Datei auswählen.')
  if (!type) throw new Error('Bitte einen Dokumenttyp auswählen.')

  let path: string
  try {
    path = await uploadDocument(user.companyId, file)
  } catch (err) {
    // Ausführlich in die Server-Logs schreiben (in Vercel unter "Runtime
    // Logs" sichtbar), damit sich zukünftige Upload-Fehler direkt anhand
    // der echten Fehlermeldung diagnostizieren lassen, statt nur den
    // generischen "Application error" zu sehen.
    console.error('Dokument-Upload fehlgeschlagen:', { driverId, fileName: file.name, fileSize: file.size, fileType: file.type, error: err })
    throw new Error(`Dokument-Upload fehlgeschlagen: ${(err as Error).message}`)
  }

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driverDocument.create({
      data: { driverId, type, side, fileUrl: path }
    })
  )

  revalidatePath(`/fahrer/${driverId}`)
}

export async function deleteDriverDocument(driverId: string, documentId: string) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.driverDocument.delete({ where: { id: documentId } })
  )

  revalidatePath(`/fahrer/${driverId}`)
}
