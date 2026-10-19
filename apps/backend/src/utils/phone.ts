/**
 * International phone numbers (ITU-T E.164) for contact details such as a Seller's WhatsApp number.
 * A number must carry its country code. This checks the structure and that the code is a real
 * country calling code; it cannot tell whether the subscriber number itself exists.
 */

const ONE_DIGIT_CODES = new Set(['1', '7'])
const TWO_DIGIT_CODES = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
])
/** Three-digit calling codes. Whole blocks are accepted where nearly every code is assigned. */
const THREE_DIGIT_RANGES: [number, number][] = [
  [210, 218], [220, 299], [350, 359], [370, 389], [420, 423], [500, 509], [590, 599],
  [670, 692], [850, 856], [870, 886], [960, 977], [992, 998],
]

function hasKnownCountryCode(digits: string): boolean {
  if (ONE_DIGIT_CODES.has(digits[0])) return true
  if (TWO_DIGIT_CODES.has(digits.slice(0, 2))) return true
  const three = Number(digits.slice(0, 3))
  return THREE_DIGIT_RANGES.some(([from, to]) => three >= from && three <= to)
}

/** Returns the canonical `+<digits>` form, or null when the input is not a valid international number. */
export function normalizeInternationalPhone(raw: string): string | null {
  let s = raw.trim().replace(/[\s\-().]/g, '')
  if (s.startsWith('00')) s = `+${s.slice(2)}`
  // No country code given: assume Sri Lanka (0771234567 or 771234567 -> +94771234567)
  else if (!s.startsWith('+') && /^\d+$/.test(s)) s = `+94${s.replace(/^0/, '')}`
  // E.164: "+", a non-zero country code, 8 to 15 digits in total
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null
  const digits = s.slice(1)
  if (!hasKnownCountryCode(digits)) return null
  // Sri Lanka: WhatsApp runs on mobile numbers (+94 7X XXX XXXX)
  if (digits.startsWith('94') && !/^947\d{8}$/.test(digits)) return null
  return `+${digits}`
}

export const INTERNATIONAL_PHONE_MESSAGE =
  'Enter a valid mobile number, e.g. 0771234567 or +94771234567 (+94 is added automatically when no country code is given)'

/**
 * Numbers an SMS may be sent to: Sri Lankan mobiles only (+947XXXXXXXX), the format SMSlenz expects.
 * Other countries are refused so the gateway cannot be used to pump messages to costly destinations.
 */
export function normalizeSmsPhone(raw: string): string | null {
  const n = normalizeInternationalPhone(raw)
  return n && /^\+947\d{8}$/.test(n) ? n : null
}

export const SMS_PHONE_MESSAGE = 'Enter a valid Sri Lankan mobile number, e.g. 0771234567 or +94771234567'
