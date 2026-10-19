/**
 * Click-to-chat helpers. Opening a wa.me link only opens WhatsApp with an editable, pre-filled
 * message; nothing is sent until the user presses Send there, and delivery cannot be confirmed.
 */

/** Digits only, with country code and no "+", or null when the input is not a usable number. */
export function toWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (!s || /[^\d\s\-().+]/.test(s)) return null
  const international = s.startsWith('+') || s.startsWith('00')
  s = s.replace(/\D/g, '')
  if (s.startsWith('00') && international) s = s.slice(2)
  else if (!international && s.startsWith('0')) s = `94${s.slice(1)}` // Sri Lankan local format
  else if (!international && s.length === 9) s = `94${s}`
  // E.164: non-zero country code, 8–15 digits in total
  if (!/^[1-9]\d{7,14}$/.test(s)) return null
  // Sri Lanka: WhatsApp runs on mobile numbers (94 7X XXX XXXX)
  if (s.startsWith('94') && !/^947\d{8}$/.test(s)) return null
  return s
}

/** `https://wa.me/<number>[?text=…]`, or null when the number is missing/invalid. */
export function buildWhatsAppUrl(phone: string | null | undefined, message?: string): string | null {
  const number = toWhatsAppNumber(phone)
  if (!number) return null
  const text = message?.trim()
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

export function customerGreeting(name: string, partnerName?: string): string {
  const who = partnerName ? ` This is ${partnerName} from Hexalyte.` : ''
  return `Hello ${name},${who} I'm following up regarding your Hexalyte account.`
}
