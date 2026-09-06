# License keys & plans

Plans live on `Organization.plan` (`FREE` | `PRO` | `AGENCY`) with an optional
`planExpiresAt`. A plan is activated by redeeming a single-use **license key** —
there is no in-app checkout yet. Sell keys on a marketplace or hand them out
directly; a payment-provider webhook can later call `setOrgPlan()` instead.

The `zx_` ingest key is unrelated — that is sync auth, not billing.

## Plan limits

| Plan | tracked businesses* | monthly AI budget |
|------|--------------------:|------------------:|
| Free | 1 | env default (`AI_MONTHLY_COST_CAP_USD`, $5) |
| Pro | 10 | $10 |
| Agency | 100 | $50 |

\* surfaced in `GET /api/billing/status`; **not** hard-enforced at ingest yet —
enforcement is a deliberate follow-up so no existing user is cut off. The AI
budget IS enforced (`enforceCostCap` in `ai-reply.service.ts`).

## Mint keys

Inside the `gbp_backend` container:

```bash
# dry run — prints codes, writes nothing
docker exec gbp_backend npx ts-node scripts/mint-license-keys.ts --plan PRO --count 20 --days 365 --note "gumroad batch 1"

# write them
docker exec gbp_backend npx ts-node scripts/mint-license-keys.ts --plan PRO --count 20 --days 365 --note "gumroad batch 1" --apply
```

Codes look like `ZX-PRO-K4M9-7XQP-2W6H`. Save the printed list — the code is all
that is needed to redeem, and it is stored in plain text (it is a coupon, not a
credential). `--days` defaults to 365.

## Redeem

- **Extension**: Cloud Sync settings → paste the key → Redeem. (`background.js`
  `redeemLicenseKey` → `POST /api/billing/redeem`.)
- **API**: `POST /api/billing/redeem` `{ "code": "ZX-PRO-…" }` with a backend JWT
  or the `zx_` key. Returns the new plan status.

Redemption rules (`computeNewExpiry`): redeeming the same or a higher plan while
still active **extends** from the current expiry; a lapsed plan or a lower-tier
key starts a fresh term from today. Keys are single-use — a second redemption of
the same code is rejected.

## Inspect / revoke

```bash
# list redeemed keys
docker exec gbp_postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT code, plan, redeemed_at, redeemed_by_org_id FROM license_keys WHERE redeemed_at IS NOT NULL ORDER BY redeemed_at DESC;"

# revoke an un-redeemed key
docker exec gbp_postgres psql -U gbp_dev -d gbp_database -c \
  "UPDATE license_keys SET revoked_at = now() WHERE code = 'ZX-PRO-…' AND redeemed_at IS NULL;"
```

Revoking does not claw back a plan already granted — adjust the org row directly
for that.
