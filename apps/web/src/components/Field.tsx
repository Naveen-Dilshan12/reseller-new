import type { InputHTMLAttributes } from 'react'

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string
  name: string
  error?: string
  hint?: string
  multiline?: boolean
  className?: string
  onChange: (name: string, value: string) => void
}

export function Field({ label, name, error, hint, multiline, className, onChange, ...input }: FieldProps) {
  const id = `f-${name.replace(/\./g, '-')}`
  return (
    <div className={`field ${error ? 'has-error' : ''} ${className ?? ''}`}>
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea
          id={id}
          name={name}
          rows={2}
          value={input.value as string}
          onChange={(e) => onChange(name, e.target.value)}
          aria-invalid={!!error}
        />
      ) : (
        <input id={id} name={name} {...input} onChange={(e) => onChange(name, e.target.value)} aria-invalid={!!error} />
      )}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}
