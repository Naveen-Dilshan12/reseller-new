# Partner Trial API – requirement for each Hexalyte SaaS

The Central Reseller Platform creates trial accounts **by calling the SaaS**. It
never re-implements SaaS registration. Each SaaS must expose the small
`/partner/v1` API below; the platform's integration classes
(`apps/backend/src/modules/integrations/providers/*.integration.ts`) already
speak this contract.

Until a SaaS ships these endpoints, its product stays in **Manual fulfilment**
and resellers see “Trial creation through the reseller platform is not
available for this product yet”. No trial is faked or created by the platform.

## Current state (audited 2026-09-29)

| SaaS | Existing registration | Why it cannot be used as-is |
|---|---|---|
| Mobile Shop | Public `POST /auth/register` → `authService.registerTenant()` | Requires the owner's password; returns owner access/refresh tokens; sends the password over WhatsApp; no service authentication, idempotency or reseller attribution; accepts `plan` (STARTER/PRO/ENTERPRISE). |
| Clothing ERP (main ERP) | Public `POST /v1/tenants/register` → `TenantsService.register()` | Requires `adminPassword` and `subdomain`; no service authentication, idempotency or reseller attribution. |
| Salon | `POST /api/platform/tenants` → `platformController.createTenant` | Requires a Salon super-admin JWT; accepts any `plan` and `status`, i.e. can create paid, active tenants; requires the owner's password. |

None of them can be called safely by the platform: it would have to handle
tenant owner passwords and tokens, retries could create duplicate tenants, and
nothing would stop a paid plan from being created.

## What each SaaS must add

Wrap the **existing** registration function; do not write a second one.

| SaaS | Reuse | Changes inside the partner endpoint |
|---|---|---|
| Mobile Shop | Tenant + branch + owner creation, `getPlatformGeneral().trialDays`, demo data from `registerTenant()` | Extract the core of `registerTenant()` into a function that takes no password. Force `plan: TRIAL`, `status: TRIAL`. Create the owner without a password and send the existing reset-password flow as a “set your password” link. Do not issue session tokens or send credentials over WhatsApp. |
| Clothing ERP | `TenantsService.register()` including trial subscription and `tenant.registered` event | Derive `subdomain` from `companyName` (unique, like Mobile Shop's slug logic). No `adminPassword`; send an invitation / set-password link. Force the default trial plan. |
| Salon | Body of `platformController.createTenant` (slug, caps, branch, owner, `addTrialDaysFromConfig()`) | Move into a service function. Force `plan: 'trial'`, `status: 'active'`. No password; use the existing forgot/reset-password flow as an invitation. |

All three also need:

1. **Two new tenant columns**: `resellerCode` (string) and `externalRef`
   (string, **unique**). They record which reseller brought the tenant and
   make the create call idempotent.
2. **A partner credential**: one API key (store only its hash) and one shared
   signing secret, entered in the platform under *Admin → Products → Configure*.
   The key may only call `/partner/v1/*` routes.

## Security

Every request from the platform carries:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <API key>` |
| `X-Hexalyte-Timestamp` | Unix seconds |
| `X-Hexalyte-Signature` | `sha256=` + hex HMAC-SHA256(signingSecret, `timestamp.METHOD.path.body`) |
| `Idempotency-Key` | UUID per attempt (POST only) |

`path` includes the `/partner/v1` prefix and the query string, and `body` is the raw JSON (empty string for GET).
The SaaS must reject requests whose timestamp is more than 300 s old and must
compare signatures in constant time (see `src/modules/integrations/signing.ts`).

Responses use the standard envelope `{ "success": true, "data": { … } }` or
`{ "success": false, "message": "…" }`. **4xx messages are shown to resellers**,
so they must be user-safe (e.g. “This email is already registered”). Responses
must never contain passwords, tokens or tenant business data.

## Endpoints

### 1. `POST /partner/v1/tenants` – create a trial tenant

Rules:

- **Trial only.** The endpoint must ignore or reject any plan/status input and
  always create the SaaS's standard trial. A reseller can never create a paid
  subscription.
- **Idempotent on `externalRef`.** If a tenant already exists for the same
  `externalRef`, return it with `200` (do not create another, do not return 409).
- Use the SaaS's own trial length, validation and onboarding (welcome email,
  demo data, etc.).
- Respond within 15 s. If provisioning takes longer, return `202` with a
  `reference` and finish asynchronously. The platform then polls endpoint 2.

Request body (field names follow each SaaS's existing registration DTO):

Mobile Shop

```json
{
  "idempotencyKey": "5c7c…",
  "externalRef": "clx123customeraccount",
  "resellerCode": "RS-4F7K2A",
  "shopName": "Kandy Mobiles",
  "ownerName": "Nimal Perera",
  "ownerEmail": "nimal@example.lk",
  "phone": "+94771234567"
}
```

Clothing ERP

```json
{
  "idempotencyKey": "5c7c…",
  "externalRef": "clx123customeraccount",
  "resellerCode": "RS-4F7K2A",
  "companyName": "Kandy Fashions",
  "adminFirstName": "Nimal",
  "adminLastName": "Perera",
  "adminEmail": "nimal@example.lk",
  "phone": "+94771234567",
  "country": "LK",
  "currency": "LKR"
}
```

Salon

```json
{
  "idempotency_key": "5c7c…",
  "external_ref": "clx123customeraccount",
  "reseller_code": "RS-4F7K2A",
  "name": "Glow Salon",
  "owner_name": "Nimal Perera",
  "owner_email": "nimal@example.lk",
  "owner_phone": "+94771234567",
  "plan": "trial"
}
```

Responses:

| Status | Meaning | `data` |
|---|---|---|
| `201` | Tenant created | Tenant object (below) |
| `200` | Tenant already existed for this `externalRef` | Tenant object |
| `202` | Accepted, provisioning asynchronously | `{ "reference": "…" }` |
| `400` / `422` | Validation failed | – (`message` shown to reseller) |
| `409` | Email / business already registered under a **different** `externalRef` | – (`message` shown to reseller) |
| `401` / `403` | Bad API key or signature | – |

Tenant object (Mobile Shop / ERP use camelCase, Salon uses snake_case):

```json
{
  "tenantId": "ckv9…",
  "ownerUserId": "ckw1…",
  "status": "TRIAL",
  "plan": "TRIAL",
  "trialEndsAt": "2026-10-13T00:00:00.000Z"
}
```

- Mobile Shop: `ownerUserId`; statuses `TRIAL | ACTIVE | SUSPENDED | CANCELLED`
- ERP: `adminUserId`; same statuses
- Salon: `tenant_id`, `owner_user_id`, `status` (`active | suspended | cancelled`), `plan`, `trial_ends_at`, optional `subscription_status`, `current_period_end`

### 2. `GET /partner/v1/tenants/by-reference/{externalRef}`

Returns the tenant object for a previous create call, or `404` if none exists.
The platform uses this to recover interrupted requests (timeouts) and to
complete `202` requests.

### 3. `GET /partner/v1/tenants/{tenantId}/status`

Returns the tenant object. Used for the “Live status” view; the platform does
not store the result.

### 4. `GET /partner/v1/health`

Returns `200` with any body when the API key and signature are valid. Used by
*Test connection*.

## What the platform stores

Only the mapping: `resellerId`, `customerId`, `productId`, `externalTenantId`,
`externalAccountId`, status and timestamps. The owner's name, email and phone
are forwarded once and are **not** stored. The trial end date and plan are
read live from endpoint 3 when needed.

## Enabling a product once its API is live

1. Deploy the endpoints above in the SaaS and create the partner API key and
   signing secret.
2. In the platform, go to *Admin → Products → (product) → Configure*, choose the
   product's implementation (e.g. *Mobile Shop partner API*), and enter the base
   URL, API key and signing secret.
3. Click *Test connection*. It should show **Connected**.
4. Resellers with access to the product can now create trials.
