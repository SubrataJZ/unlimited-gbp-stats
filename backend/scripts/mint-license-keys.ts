/**
 * mint-license-keys.ts — generate license keys for a plan.
 *
 * Dry run by default (prints codes it WOULD create, writes nothing).
 * `--apply` writes them to the license_keys table.
 *
 * Usage (inside the gbp_backend container):
 *   npx ts-node scripts/mint-license-keys.ts --plan PRO --count 20 [--days 365] [--note "gumroad batch 1"] [--apply]
 *
 * Print the codes somewhere safe — only the code is needed to redeem, and it is
 * stored in plain text (it is a coupon, not a secret credential).
 */

import { PrismaClient, Plan } from '@prisma/client';
import { generateLicenseCode } from '../src/services/billing.service';

function parseArgs(argv: string[]) {
  const out: { plan?: string; count?: number; days?: number; note?: string; apply: boolean } = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') out.plan = argv[++i];
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--apply') out.apply = true;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const plan = String(args.plan || '').toUpperCase() as Plan;
  if (!['FREE', 'PRO', 'AGENCY'].includes(plan)) {
    console.error('Usage: --plan <FREE|PRO|AGENCY> --count <n> [--days 365] [--note "..."] [--apply]');
    process.exit(1);
  }
  const count = Number.isFinite(args.count) && (args.count as number) > 0 ? Math.floor(args.count as number) : 0;
  if (!count || count > 1000) {
    console.error('--count must be between 1 and 1000');
    process.exit(1);
  }
  const durationDays = args.days && args.days > 0 ? Math.floor(args.days) : 365;

  console.log(`\n=== Mint ${count} × ${plan} key(s), ${durationDays} days${args.note ? ` — "${args.note}"` : ''} — ${args.apply ? 'APPLY' : 'DRY RUN'} ===\n`);

  const codes: string[] = [];
  while (codes.length < count) {
    const c = generateLicenseCode(plan);
    if (!codes.includes(c)) codes.push(c);
  }
  codes.forEach((c) => console.log('  ' + c));

  if (!args.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  const prisma = new PrismaClient();
  try {
    const res = await prisma.licenseKey.createMany({
      data: codes.map((code) => ({ code, plan, durationDays, note: args.note ?? null })),
      skipDuplicates: true,
    });
    console.log(`\nWrote ${res.count} key(s) to license_keys.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
