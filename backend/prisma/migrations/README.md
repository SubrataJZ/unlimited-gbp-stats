# Migrations

`00000000000000_init` is a **baseline**, not a historical record.

Until August 2026 this project had no working migration history. Every deploy
ran `prisma db push --accept-data-loss`, which syncs the database directly from
`schema.prisma` — and is authorised to drop columns and tables to do it. The
migration folders that existed alongside it were never able to build the schema
from scratch: eight tables, including `users` and `locations`, had no migration
at all, and the oldest migration's foreign keys referenced tables nothing
created. A fresh `migrate deploy` would have failed on the first statement.

Those folders were replaced with a single init generated from the live schema
(`prisma migrate diff --from-empty --to-schema-datamodel`). It creates all 22
tables. Deleting the old folders lost no information, because none of them had
ever been recorded as applied anywhere — `db push` does not write to
`_prisma_migrations`.

## What this means going forward

**A schema change is not deployed until it has a migration.** Editing
`schema.prisma` alone now does nothing in production, where `db push` used to
pick it up silently. Generate one with:

```
npx prisma migrate dev --name what_changed
```

and commit the folder it creates.

## The production baseline

The live database has all these tables already but no `_prisma_migrations`
table, so its first `migrate deploy` fails with P3005 ("the database schema is
not empty"). `entrypoint.sh` detects exactly that error and baselines — marking
the init as applied without running its SQL — then retries. That path writes
only to `_prisma_migrations` and cannot touch application data. It runs once;
every deploy after it takes the normal path.
