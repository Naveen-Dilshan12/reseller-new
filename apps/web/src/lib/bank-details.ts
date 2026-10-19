/**
 * The company bank account is stored as one free-text setting (Admin → Settings). The reseller "Our Bank Details" page
 * splits it into bank name / account holder / account number / branch ONLY where the admin wrote a recognised
 * `Label: value` line. Nothing is guessed from position or wording: lines without a known label are returned untouched
 * in `other`, so no value is ever invented, dropped or re-ordered. The only entries left out are the ones that carry no
 * value at all (an empty `Label:`, punctuation) so a label-only template never passes for bank details; see `bankDetailLines`.
 */

export type BankField = 'accountHolder' | 'bankName' | 'accountNumber' | 'branch'

export interface ParsedBankDetails {
  fields: Record<BankField, string | null>
  /** Lines that were not a recognised `Label: value` pair, in their original order. */
  other: string[]
}

/** Accepted labels, compared case-insensitively and exactly (so "Account Name" never counts as an account number). */
const LABELS: Record<BankField, string[]> = {
  accountHolder: ['account holder', 'account holder name', 'account name', 'a/c name', 'a/c holder', 'acc name', 'account title', 'beneficiary', 'beneficiary name'],
  bankName: ['bank', 'bank name'],
  accountNumber: ['account number', 'account no', 'account #', 'a/c number', 'a/c no', 'a/c', 'acc no', 'acc number'],
  branch: ['branch', 'branch name'],
}

const FIELD_BY_LABEL = new Map<string, BankField>(
  (Object.keys(LABELS) as BankField[]).flatMap((field) => LABELS[field].map((label): [string, BankField] => [label, field])),
)

const normalizeLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim()

/** Something a reader could act on: at least one letter or digit. `Bank Name:`, `Bank Name: ____` and `-` are template leftovers, not details. */
const hasContent = (text: string) => /[\p{L}\p{N}]/u.test(text)

/** A `Label:` entry with nothing usable after the colon. */
const isEmptyLabel = (line: string) => {
  const colon = line.indexOf(':')
  return colon > 0 && !hasContent(line.slice(colon + 1))
}

/**
 * The entries of the setting (one per line, `|` or `;`) that carry information. Blank or punctuation-only entries and
 * `Label:` entries without a value are left out, so an admin template such as "Bank Name:\nAccount Number:" is not shown as
 * if it were bank details. An empty label is kept only when the very next entry is a plain value line ("Bank Name:" above
 * "Bank of Ceylon"), so a value written under its label stays with it. Everything else comes back untouched and in order.
 */
export function bankDetailLines(text: string | null | undefined): string[] {
  const entries = (text ?? '')
    .split(/\r?\n|\||;/)
    .map((line) => line.trim())
    .filter(Boolean)
  return entries.filter((line, i) => {
    if (!hasContent(line)) return false
    if (!isEmptyLabel(line)) return true
    const next = entries[i + 1]
    return next !== undefined && !next.includes(':') && hasContent(next)
  })
}

/** True when the setting contains at least one real detail. False for null, blank text and label-only templates. */
export const hasBankDetails = (text: string | null | undefined) => bankDetailLines(text).length > 0

export function parseBankDetails(text: string | null | undefined): ParsedBankDetails {
  const result: ParsedBankDetails = {
    fields: { accountHolder: null, bankName: null, accountNumber: null, branch: null },
    other: [],
  }
  for (const line of bankDetailLines(text)) {
    const colon = line.indexOf(':')
    const field = colon > 0 ? FIELD_BY_LABEL.get(normalizeLabel(line.slice(0, colon))) : undefined
    const value = colon > 0 ? line.slice(colon + 1).trim() : ''
    // The first value for a field wins; a repeated one (or a label with its value on the next line) stays visible as an ordinary line.
    if (field && value && result.fields[field] === null) result.fields[field] = value
    else result.other.push(line)
  }
  return result
}

export const hasBankField = (parsed: ParsedBankDetails) => Object.values(parsed.fields).some((v) => v !== null)
