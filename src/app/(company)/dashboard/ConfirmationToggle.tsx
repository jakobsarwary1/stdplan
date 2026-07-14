'use client'

import { useTransition } from 'react'
import { toggleMonthlyConfirmation, type ConfirmationField } from './actions'

export function ConfirmationToggle({
  driverId, year, month, field, checked, label
}: {
  driverId: string
  year: number
  month: number
  field: ConfirmationField
  checked: boolean
  label: string
}) {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    const formData = new FormData()
    formData.set('driverId', driverId)
    formData.set('year', String(year))
    formData.set('month', String(month))
    formData.set('field', field)
    formData.set('nextValue', String(!checked))
    startTransition(() => {
      toggleMonthlyConfirmation(formData)
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      title={label}
      className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs transition-colors ${
        checked
          ? 'border-success/50 bg-success/15 text-success'
          : 'border-border bg-surfaceAlt text-textMuted hover:border-accent/50'
      } ${isPending ? 'opacity-50' : ''}`}
    >
      {checked ? '✓' : ''}
    </button>
  )
}
