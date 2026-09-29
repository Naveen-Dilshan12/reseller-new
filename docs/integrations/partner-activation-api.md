# Partner Subscription Activation API – requirement for each Hexalyte SaaS

Paid activations start in the Central Reseller Platform, but **the subscription
is activated by the SaaS**, using its own subscription/billing code. The
platform does not calculate periods, create invoices, or change plans.

```
Reseller submits request + bank slip  ──►  Platform admin reviews slip, verifies
(PENDING_REVIEW)                           payment, approves (UNDER_REVIEW → APPROVED)
                                                         │
                     ┌───────────────────────────────────┴───────────────────────┐
                     ▼                                                           ▼
     Partner API configured: POST …/subscription-activations       Manual fulfilment: admin activates in
     SaaS runs its existing approval code                          the SaaS admin console, then records the
                                                                   SaaS reference in the platform
                     └───────────────────────────────────┬───────────────────────┘
                                                         ▼
                        ACTIVATION_COMPLETED → reseller commission (PAYMENT_VERIFIED)
```

Resellers can create and cancel their own requests. They cannot review,
approve, reject, or activate.

## Existing flows to reuse (audited 2026-09-29)

| SaaS | Existing admin flow that activates a paid subscription | What the partner endpoint must call |
|---|---|---|
| Mobile Shop | `POST /admin/payments/:id/approve` and `POST /admin/subscriptions/:tenantId/confirm-payment` → `approveSubscriptionPayment()` in `billing.service.ts` | Create a `SubscriptionPayment` (method bank transfer, reference = `paymentReference`, amount, period), then call `approveSubscriptionPayment()` so invoice, `subscriptionEndsAt`, status and activity log are handled exactly as today. |
| Salon | `PATCH /api/billing/bank-slip/:id/approve` → `bankSlipController.approveBankSlip` (sets plan, status `active`, caps, creates `Subscription`, marks `PlatformInvoice` paid) | Move the body of `approveBankSlip` into a service function that takes a tenant, plan and payment reference instead of a Salon `BankSlip` row, and call it. |
| Clothing ERP | `PUT /v1/tenants/:id` (`UpdateTenantAdminDto`) and the subscription invoice helpers | Add a `TenantsService.activatePaidSubscription()` that reuses the same plan/period logic as the admin update and marks the subscription invoice paid. |

Until a SaaS ships this endpoint, the product stays in **Manual fulfilment**.
The platform admin uses the existing admin flow above, then clicks **Mark
activation completed** and enters the SaaS reference (for example, the invoice
number).

## Security

Same credential and signing rules as the trial API
(`partner-trial-api.md` → *Security*): Bearer API key, `x-hexalyte-timestamp`,
`x-hexalyte-signature` (HMAC-SHA256), `Idempotency-Key`, and no redirects.

The bank slip is **not** sent to the SaaS. It stays encrypted in the platform's
private storage, and every view is audited.

## Endpoints

### 1. `POST /partner/v1/tenants/{tenantId}/subscription-activations`

Called once per approved request. Retries reuse the same `Idempotency-Key`.

```json
{
  "idempotencyKey": "b0c7…",
  "externalRef": "AR-7KQ2MX",
  "periodMonth": "2026-10",
  "amount": "5500.00",
  "currency": "LKR",
  "paymentMethod": "BANK_TRANSFER",
  "paymentReference": "BOC-TX-99812",
  "paymentDate": "2026-09-28",
  "verifiedBy": "finance@hexalyte.lk"
}
```

Salon receives the same fields in snake_case (`external_ref`, `period_month`, …).

Rules for the SaaS:

- **Deduplicate on `externalRef`.** A repeat call must return the original
  result, never activate twice.
- Reject with `422` and a message if the tenant is cancelled, the amount does
  not match the plan price, or the period is already paid.
- Only activate the product's standard paid plan. Never accept a plan or status
  from the caller.

Response `201` (activated) or `202` (accepted, finishing asynchronously):

```json
{ "success": true, "data": {
  "requestId": "act_123",
  "status": "ACTIVATED",
  "subscriptionReference": "INV-2026-0042",
  "message": "Subscription extended to 2026-10-31"
} }
```

The platform maps `status` values as follows:

- `ACTIVATED`, `ACTIVE`, `COMPLETED`, `APPROVED` and `PAID` count as done. A `202` response is always treated as pending.
- `FAILED`, `REJECTED` and `ERROR` count as failed. `message` is shown to the admin.
- Anything else is treated as pending.

The SaaS reference may be returned as `subscriptionReference`, `invoiceId` or
the snake_case variants.

### 2. `GET /partner/v1/subscription-activations/{requestId}`

Returns the same body. The admin uses **Check status** while a request is pending.

## What the platform stores

The platform stores the request, the encrypted slip, the review and status
history, and from the SaaS only `saasRequestId`, `activationReference` and the
outcome message. It does not store subscription periods, invoices or plan details.
