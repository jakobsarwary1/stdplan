'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireCompanyUser } from '@/lib/auth'
import { withTenantContext } from '@/lib/prisma'

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? '').trim()
  return v || null
}

function date(formData: FormData, key: string): Date | null {
  const v = str(formData, key)
  return v ? new Date(v) : null
}

function int(formData: FormData, key: string): number | null {
  const v = str(formData, key)
  return v ? parseInt(v, 10) : null
}

/** Wandelt einen doppeltes-Kennzeichen-Fehler in eine verständliche Meldung um. */
function friendlyVehicleDuplicateError(err: unknown): Error {
  const e = err as { code?: string }
  if (e?.code === 'P2002') {
    return new Error('Es gibt bereits ein Fahrzeug mit exakt diesem Kennzeichen in deiner Firma.')
  }
  return err instanceof Error ? err : new Error('Unbekannter Fehler beim Speichern.')
}

export async function createVehicle(formData: FormData) {
  const user = await requireCompanyUser()

  const licensePlate = str(formData, 'licensePlate')
  if (!licensePlate) throw new Error('Kennzeichen ist erforderlich.')

  let vehicle
  try {
    vehicle = await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
      tx.vehicle.create({
        data: {
          companyId: user.companyId,
          licensePlate,
          vin: str(formData, 'vin'),
          brand: str(formData, 'brand'),
          model: str(formData, 'model'),
          year: int(formData, 'year'),
          color: str(formData, 'color')
        }
      })
    )
  } catch (err) {
    throw friendlyVehicleDuplicateError(err)
  }

  revalidatePath('/fahrzeuge')
  redirect(`/fahrzeuge/${vehicle.id}`)
}

export async function updateVehicleStammdaten(vehicleId: string, formData: FormData) {
  const user = await requireCompanyUser()

  try {
    await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
      tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          licensePlate: str(formData, 'licensePlate') ?? undefined,
          vin: str(formData, 'vin'),
          brand: str(formData, 'brand'),
          model: str(formData, 'model'),
          year: int(formData, 'year'),
          color: str(formData, 'color'),
          mileage: int(formData, 'mileage') ?? 0,
          status: (str(formData, 'status') as any) ?? 'active',
          shiftTemplateId: str(formData, 'shiftTemplateId')
        }
      })
    )
  } catch (err) {
    throw friendlyVehicleDuplicateError(err)
  }

  revalidatePath(`/fahrzeuge/${vehicleId}`)
  redirect(`/fahrzeuge/${vehicleId}?tab=stammdaten&saved=1`)
}

export async function updateVehicleBesitz(vehicleId: string, formData: FormData) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.vehicle.update({
      where: { id: vehicleId },
      data: {
        ownershipType: (str(formData, 'ownershipType') as any) ?? 'company',
        registrationDate: date(formData, 'registrationDate'),
        concessionNumber: str(formData, 'concessionNumber'),
        tuvUntil: date(formData, 'tuvUntil'),
        rentalPermitUntil: date(formData, 'rentalPermitUntil'),
        envBadge: str(formData, 'envBadge'),
        euroNorm: str(formData, 'euroNorm')
      }
    })
  )

  revalidatePath(`/fahrzeuge/${vehicleId}`)
  redirect(`/fahrzeuge/${vehicleId}?tab=besitz&saved=1`)
}

export async function deleteVehicle(vehicleId: string) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.vehicle.delete({ where: { id: vehicleId } })
  )

  revalidatePath('/fahrzeuge')
  redirect('/fahrzeuge')
}

const DRIVER_ROLE_STAMM = 'stamm'

export async function addVehicleDriverAssignment(vehicleId: string, formData: FormData) {
  const user = await requireCompanyUser()

  const driverId = str(formData, 'driverId')
  const role = str(formData, 'role')
  if (!driverId || !role) throw new Error('Fahrer und Rolle sind erforderlich.')

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, async (tx) => {
    // Nur ein Stammfahrer gleichzeitig je Fahrzeug - ein neuer Stammfahrer
    // stuft einen bisherigen automatisch zurück (nicht entfernen!).
    if (role === DRIVER_ROLE_STAMM) {
      await tx.vehicleDriverAssignment.updateMany({
        where: { vehicleId, role: 'stamm' },
        data: { role: 'zweit' }
      })
      await tx.vehicle.update({ where: { id: vehicleId }, data: { defaultDriverId: driverId } })
    }

    await tx.vehicleDriverAssignment.create({
      data: { vehicleId, driverId, role: role as any }
    })
  })

  revalidatePath(`/fahrzeuge/${vehicleId}`)
}

export async function removeVehicleDriverAssignment(vehicleId: string, assignmentId: string) {
  const user = await requireCompanyUser()

  await withTenantContext({ companyId: user.companyId, isSuperAdmin: false }, (tx) =>
    tx.vehicleDriverAssignment.delete({ where: { id: assignmentId } })
  )

  revalidatePath(`/fahrzeuge/${vehicleId}`)
}
