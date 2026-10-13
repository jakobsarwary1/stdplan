'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'
import { padEmployeeNumber } from '@/lib/employeeNumber'

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? '').trim()
  return v || null
}

function date(formData: FormData, key: string): Date | null {
  const v = str(formData, key)
  return v ? new Date(v) : null
}

/**
 * Wandelt einen Prisma-Unique-Constraint-Fehler (P2002, z. B. doppelter
 * Name/Personalnummer/SV-Nummer/Steuer-ID) in eine verständliche deutsche
 * Fehlermeldung um, statt den rohen Datenbankfehler durchzureichen (der zu
 * einem generischen "Application error" führen würde).
 */
function friendlyDriverDuplicateError(err: unknown): Error {
  const e = err as { code?: string; meta?: { target?: string[] } }
  if (e?.code === 'P2002') {
    const target = e.meta?.target?.join(',') ?? ''
    if (target.includes('firstName') || target.includes('name')) {
      return new Error('Es gibt bereits einen Fahrer mit exakt diesem Vor- und Nachnamen in deiner Firma.')
    }
    if (target.includes('employeeNumber') || target.includes('employeenumber')) {
      return new Error('Diese Personalnummer ist bereits einem anderen Fahrer zugeordnet.')
    }
    if (target.includes('socialSecurityNumber') || target.includes('svnumber')) {
      return new Error('Diese SV-Nummer ist bereits einem anderen Fahrer zugeordnet.')
    }
    if (target.includes('taxId') || target.includes('taxid')) {
      return new Error('Diese Steuer-ID ist bereits einem anderen Fahrer zugeordnet.')
    }
    return new Error('Dieser Wert ist bereits bei einem anderen Fahrer vorhanden (Duplikat).')
  }
  return err instanceof Error ? err : new Error('Unbekannter Fehler beim Speichern.')
}

export async function createDriver(formData: FormData) {
  const user = await requireCompanyUser()

  const firstName = str(formData, 'firstName')
  const lastName = str(formData, 'lastName')
  if (!firstName || !lastName) throw new Error('Vor- und Nachname sind erforderlich.')

  let driver
  try {
    driver = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
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
  } catch (err) {
    throw friendlyDriverDuplicateError(err)
  }

  revalidatePath('/fahrer')
  redirect(`/fahrer/${driver.id}`)
}

export async function updateDriverPersoenlich(driverId: string, formData: FormData) {
  const user = await requireCompanyUser()

  try {
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
  } catch (err) {
    throw friendlyDriverDuplicateError(err)
  }

  revalidatePath(`/fahrer/${driverId}`)
  redirect(`/fahrer/${driverId}?tab=persoenlich&saved=1`)
}

export async function updateDriverBeschaeftigung(driverId: string, formData: FormData) {
  const user = await requireCompanyUser()

  try {
    await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
      tx.driver.update({
        where: { id: driverId },
        data: {
          employmentType: (str(formData, 'employmentType') as any) ?? 'fulltime',
          status: (str(formData, 'status') as any) ?? 'active',
          employeeNumber: padEmployeeNumber(str(formData, 'employeeNumber')),
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
  } catch (err) {
    throw friendlyDriverDuplicateError(err)
  }

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
