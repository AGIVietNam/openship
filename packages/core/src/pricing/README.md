# Openship server pricing

`pricing.json` defines Openship retail prices, supported Custom sizes and application
limits. The API serves those terms through `GET /api/billing/plans`; dashboard,
website and linked installations share the catalog. Oblien owns provider pricing,
payment settlement, resource admission, metering and paid coverage.

## Monthly server offers (v10)

| Plan | Monthly price | vCPU | RAM | Disk | Managed servers |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hobby | $5 | 1 | 2 GiB | 40 GiB | 1 |
| Starter | $20 | 2 | 8 GiB | 128 GiB | 1 |
| Pro | $39 | 4 | 16 GiB | 250 GiB | 1 |
| Scale | $99 | 8 | 32 GiB | 600 GiB | 1 |

Each subscription covers its server's CPU, RAM and storage for the full paid
month, without a second compute-credit allowance. CPU is shared vCPU, not a
reserved physical core. Projects and services share the purchased resources,
including the operating system and Docker. There is no project/service count
limit or separate build-minute cap on new offers. One service can use the whole
pool; optional container limits do not reserve another VM. Source builds run on
the same host using measured headroom and the shared execution/activity locks.
Another server requires its own namespace and subscription.

Monthly servers include the provider's managed internet-transfer benefit. Read
`capacity.network` for its allowance and explicit unlimited flag; do not derive
it from CPU counts or rewrite saved compute tariffs. Public app routes and
backups are separate. Expired disks are retained for at least 30 days with no automatic deletion;
retained storage remains billable until deletion. The UI discloses provider
retention terms and amounts due instead of treating them as compute credits.

## PAYG resource tiers

`pricing.json#payg` owns the PAYG resource tiers and suggested credit packages.
The API publishes this catalog as `GET /api/billing/plans` → `payg`; the dashboard
must not derive customer tiers from the reseller owner's Oblien account plan.

| Tier | Credit purchases to unlock | Pool vCPU | Pool RAM | Pool disk | Servers |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | $5 | 2 | 8 GiB | 64 GiB | 2 |
| 2 | $20 | 4 | 16 GiB | 128 GiB | 4 |
| 3 | $50 | 8 | 32 GiB | 256 GiB | 8 |

These are Openship pool allowances shared across servers, not monthly prices or
provider account upgrades. Unlocking is based on cumulative verified credit
purchases, not the declining spendable balance. One server may use the whole
pool within effective provider limits. Adding servers does not multiply it.
Usage rates and credit conversion remain provider-owned.

The current PAYG surface previews this catalog and validates proposed allocations.
It does not grant access, change namespaces or activate checkout. Persisted
customer funding and runtime entitlement must be integrated before selling PAYG;
the preview's package selection is never payment evidence.

## Provider checkout and authority

New purchases use the existing tracked `/billing/checkout` flow:

- `kind: "subscription"`, `billingInterval: "monthly"`;
- `offer.billingMode: "monthly"`, `offer.credits: 0`, no credit policy;
- explicit `offer.capacity` and all seven `resourceLimits` fields;
- the versioned reference plus server-derived organization, namespace and limits.

The subscription remains `tierId: "reseller"`; its entitlement is `tierId: "capacity"`.
Openship checks the embedded capacity's namespace, provider, pool and paid period
against the saved subscription before exposing access. Billing admission uses the
provider's `blocking` flag. Empty legacy quotas or an empty owner wallet cannot
cancel confirmed monthly compute; manual suspension and expiry still apply.

Checkout returns are not proof of payment. Confirmation requires the specific
checkout's completed fulfillment and matching live subscription. Monthly checkout
legitimately grants zero namespace credits, so the UI verifies committed monthly
coverage. Metered subscriptions and top-ups still require their delivered credits.
Fully discounted, fulfilled purchases use the same checks. Pending, refunded,
disputed or superseded payments never show a successful new subscription.

`GET /billing/capacity/catalog` advertises deployed purchase capabilities and rates.
Openship uses `oblien@2.10.0` and the existing SDK transport. Missing monthly Stripe
support stops new sales without hiding existing subscription management. Provider
price admission stays at Oblien; Openship does not copy its affordability or
proration calculation into another pricing engine.

The published provider tariff currently exceeds Hobby, Starter and Pro retail
prices. The company has chosen to keep those retail prices and arrange its tariff
with Oblien. See [the provider handoff](../../../../docs/cloud-capacity-economics.md).
An accepted tariff and real settlement still need verification before release.

## Custom resources and plan changes

Custom reuses the same subscription and resize flow. Retail additions remain
$5 per extra vCPU, $2.50 per extra GiB RAM and $0.10 per extra GiB disk. The quote
compares every preset plus additions and selects the least expensive bundle.
For example, 1 vCPU / 2 GiB / 50 GiB costs $6; 3 vCPU / 12 GiB / 80 GiB costs
$35. A bundle discount does not enlarge the selected server. Custom starts at
2 GiB RAM, matching Hobby. Current Custom CPU
selection stops at the provider's 12-vCPU per-VM ceiling.

`GET /api/billing/subscription/quote` returns the retail price and a fingerprint
of the complete terms. Checkout accepts only the selected resources and that
fingerprint, then recalculates the retail offer on the server. `custom-v2` saves
monthly capacity and zero credits. Oblien still validates provider funding and
physical admission; a local retail quote does not purchase coverage.

Existing subscriptions use the provider's plan-change preview and confirmation,
never another replacement checkout. The UI shows its amount due, effective date
and affected projects. Pure funded upgrades apply after payment. Resource
reductions and billing-model changes wait for renewal, even when retail price
increases. Openship uses the returned direction and date without local proration.
The durable worker applies the approved resize once. Changed project membership
requires a fresh restart review. Disk shrinking remains unavailable.

## Saved contracts and metered compatibility

Renewals use saved prices, resource limits, periods and billing mode. A catalog
edit never rewrites paid terms. Existing v9 monthly subscriptions keep their
original RAM and disk allocation; adopting v10 uses an explicit plan change.
Older v1–v8 and `custom-v1` metered offers retain
their finite allowances; they can adopt monthly capacity through the explicit
provider plan-change flow at renewal. Older incomplete v1 snapshots retain their
existing safety ceilings. Unknown references or ownership mismatches fail closed.

Only eligible metered subscriptions expose credit packs and exhaustion warnings.
They retain the existing allowance, signed webhook and renewal code. Internally,
1,000 milli-credits equal one Oblien credit; these units never represent minutes.
New monthly servers cannot be fabricated with the operator's complimentary-credit
grant command. Previously saved grants can still be inspected, reused and revoked.

PAYG displays the published active-vCPU-hour, reserved-GiB-hour, retained-GiB-month
and managed-proxy rates. Customer PAYG checkout remains unavailable: the deployed
capacity confirmation spends the reseller wallet, not a customer-specific funded
balance. No purchase button is enabled for that flow.

See [the Cloud release gate](../../../../docs/openship-cloud-launch.md) for payment,
renewal, isolation and deployment acceptance requirements.
