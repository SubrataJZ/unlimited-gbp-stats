/**
 * dev-seed-key.ts — mint a local dev user + zx_ API key for testing.
 *
 * Exists because there is no way to obtain a zx_ ingest key without completing
 * a real Google OAuth flow, which makes the backend untestable locally. This
 * creates a throwaway user, resolves its organization, and prints a working key
 * so you can curl POST /api/ingest/metrics against a local stack.
 *
 * LOCAL DEVELOPMENT ONLY. This creates a real, working credential. Two gates
 * stand in front of it: NODE_ENV must not be "production", and --confirm-local
 * must be passed explicitly. It also prints the target database host before
 * writing anything, so you can see what you are about to hit.
 *
 * Usage:
 *   npx ts-node scripts/dev-seed-key.ts --confirm-local
 *   npx ts-node scripts/dev-seed-key.ts --confirm-local --email me@localhost --name my-key
 *
 * Re-running is safe: the user is upserted by a fixed googleId and the key is
 * upserted by (userId, name), so you get a fresh key for the same identity
 * rather than a pile of duplicate users.
 */
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// @prisma/client does not read .env at runtime (only the Prisma CLI does), so
// DATABASE_URL would be undefined here without this — same as src/index.ts.
dotenv.config();

const DEV_GOOGLE_ID = 'dev-local-seed';

interface Args {
  email: string;
  name: string;
  confirmLocal: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    email: 'dev@localhost',
    name: 'dev-local',
    confirmLocal: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') out.email = argv[++i];
    else if (argv[i] === '--name') out.name = argv[++i];
    else if (argv[i] === '--confirm-local') out.confirmLocal = true;
  }
  return out;
}

/**
 * Render DATABASE_URL as host:port/dbname, dropping user and password.
 * The connection string carries credentials — never print it whole.
 */
function describeTarget(url: string | undefined): string {
  if (!url) return '(DATABASE_URL is not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * Load createApiKey/resolveOrgId without booting the Express server.
 *
 * Both modules import { prisma } from '../src/index', and importing that module
 * for real calls startServer(). Pre-seeding the require cache with our own
 * client is the same technique backfill-sqlite-metrics.ts uses.
 */
function loadServices(prismaClient: unknown) {
  const indexPath = require.resolve('../src/index');
  if (!require.cache[indexPath]) {
    require.cache[indexPath] = {
      id: indexPath,
      filename: indexPath,
      loaded: true,
      exports: { prisma: prismaClient },
    } as unknown as NodeModule;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createApiKey } = require('../src/utils/apiKeys');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveOrgId } = require('../src/services/intel.service');
  return { createApiKey, resolveOrgId } as {
    createApiKey: (userId: string, name: string, expiresInDays?: number) => Promise<string>;
    resolveOrgId: (userId: string) => Promise<string>;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSING: NODE_ENV=production. This script mints a working credential.');
    process.exit(1);
  }

  console.log(`Target database: ${describeTarget(process.env.DATABASE_URL)}`);

  if (!args.confirmLocal) {
    console.error('');
    console.error('REFUSING: pass --confirm-local to proceed.');
    console.error('This creates a real user and a real, working zx_ API key.');
    console.error('Check the target database above is the one you meant.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const user = await prisma.user.upsert({
      where: { googleId: DEV_GOOGLE_ID },
      update: { email: args.email },
      create: {
        googleId: DEV_GOOGLE_ID,
        email: args.email,
        name: 'Local Dev User',
      },
      select: { id: true, email: true },
    });

    const { createApiKey, resolveOrgId } = loadServices(prisma);

    // Creates the Organization + AGENCY_ADMIN Membership when absent, which is
    // what the ingest controllers call to scope incoming data.
    const orgId = await resolveOrgId(user.id);

    const rawKey = await createApiKey(user.id, args.name);

    console.log('');
    console.log('Seeded local dev identity:');
    console.log(`  userId : ${user.id}`);
    console.log(`  email  : ${user.email}`);
    console.log(`  orgId  : ${orgId}`);
    console.log(`  keyName: ${args.name}`);
    console.log('');
    console.log('API key (shown once, not recoverable — re-run to mint a new one):');
    console.log(`  ${rawKey}`);
    console.log('');
    console.log('Smoke-test POST /api/ingest/metrics:');
    console.log('');
    console.log(`  curl -i -X POST http://localhost:3001/api/ingest/metrics \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(`    -H 'Authorization: Bearer ${rawKey}' \\`);
    console.log(`    -d '{"businesses":[{"name":"Local Test Co","googlePlaceId":"1234567890",`);
    console.log(`         "metrics":[{"metricType":"overview","year":2026,"month":7,"total":42}]}]}'`);
    console.log('');
    console.log('Then confirm the row landed:');
    console.log('');
    console.log(`  docker compose exec postgres psql -U gbp_dev -d gbp_database \\`);
    console.log(`    -c 'SELECT metric_type, year, month, total, source FROM metric_months;'`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
