import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react'

export function Button({ className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  const variantClass = variant === 'primary' ? 'btn-primary' : 'btn-ghost'
  return <button className={`btn ${variantClass} ${className}`} {...props} />
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />
}

export function Label(props: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className="label" {...props} />
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'success' | 'danger' }) {
  const toneClass =
    tone === 'success'
      ? 'bg-success/20 text-success'
      : tone === 'danger'
        ? 'bg-danger/20 text-danger'
        : 'bg-surfaceAlt text-textMuted'
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClass}`}>{children}</span>
}
