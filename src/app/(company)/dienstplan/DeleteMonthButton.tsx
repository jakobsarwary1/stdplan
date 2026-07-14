'use client'

export function DeleteMonthButton({
  action,
  confirmText,
  label,
  hiddenFields
}: {
  action: (formData: FormData) => void | Promise<void>
  confirmText: string
  label: string
  hiddenFields: Record<string, string>
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(confirmText)) e.preventDefault()
      }}
    >
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className="rounded-lg border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10"
      >
        {label}
      </button>
    </form>
  )
}
