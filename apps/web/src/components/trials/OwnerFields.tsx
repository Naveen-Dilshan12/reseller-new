import { Field } from '@/components/Field'
import type { TrialOwner } from '@/lib/trial-types'

interface Props {
  value: TrialOwner
  errors: Record<string, string>
  onChange: (owner: TrialOwner) => void
  lockBusinessName?: boolean
}

/** Owner details sent to the SaaS to create the tenant; not stored by the platform. */
export function OwnerFields({ value, errors, onChange, lockBusinessName }: Props) {
  const set = (name: string, v: string) => onChange({ ...value, [name.replace('owner.', '')]: v })
  return (
    <>
      <div className="grid-2">
        <Field
          label="Business name"
          name="owner.businessName"
          value={value.businessName}
          error={errors['owner.businessName']}
          onChange={set}
          readOnly={lockBusinessName}
          autoComplete="organization"
        />
        <Field
          label="Owner / contact name"
          name="owner.contactName"
          value={value.contactName}
          error={errors['owner.contactName']}
          onChange={set}
          autoComplete="name"
        />
        <Field
          label="Owner email"
          name="owner.contactEmail"
          type="email"
          value={value.contactEmail}
          error={errors['owner.contactEmail']}
          hint="The SaaS sends the login / set-password link here."
          onChange={set}
          autoComplete="email"
        />
        <Field
          label="Owner mobile"
          name="owner.contactPhone"
          type="tel"
          value={value.contactPhone}
          error={errors['owner.contactPhone']}
          hint="e.g. 0771234567"
          onChange={set}
          autoComplete="tel"
        />
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        These details go straight to the SaaS to create the owner account. The reseller platform does not keep them.
      </p>
    </>
  )
}
