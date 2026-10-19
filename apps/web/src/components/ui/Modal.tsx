'use client'

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  /** Accessible name announced by screen readers, e.g. "Reject request". */
  label: string
  /** Called on Escape. Pass a guard (e.g. ignore while saving) from the caller. */
  onClose: () => void
  wide?: boolean
  children: ReactNode
}

/**
 * Accessible modal dialog: `role="dialog"` + `aria-modal` + accessible name, Escape closes,
 * focus moves into the dialog on open, Tab/Shift+Tab stay inside it, background scroll is
 * locked, and focus returns to the element that opened it on close.
 * (Clicking the backdrop intentionally does NOT close it — these dialogs hold in-progress input.)
 */
export function Modal({ label, onClose, wide, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const first = dialog?.querySelector<HTMLElement>('input, textarea, select') ?? dialog?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? dialog)?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCloseRef.current()
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const firstItem = items[0]
    const lastItem = items[items.length - 1]
    if (e.shiftKey && document.activeElement === firstItem) {
      e.preventDefault()
      lastItem.focus()
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault()
      firstItem.focus()
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  )
}
