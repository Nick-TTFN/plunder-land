/**
 * The Postgres schema, as an ordered list of migrations (decision #48).
 *
 * TypeScript strings, not `.sql` files: the build is `swc ./src -d dist`,
 * which copies only what it compiles, so a `.sql` file would silently be
 * missing from `dist`.
 *
 * **Additive only.** Railway overlaps deploys and a redeploy drains for up to
 * 10 minutes (decision #46), so the old server runs against the new schema
 * for that long. No drops, no renames (a rename is a removal), no NOT NULL
 * column without a default, nothing the previous release's queries would
 * break on. Forward-only: there are no down migrations. A shipped migration
 * is never edited; a correction is a new version.
 *
 * Applied by `migrate` (migrate.ts) at boot, each version once, in its own
 * transaction, under an advisory lock.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'accounts',
    // `id` is internal and never leaves the server; `public_id` is the player
    // id (Redis keys, /stats, GA), so it can be rotated without touching the
    // foreign keys later steps hang off `id` (progress, unlocks, loadouts,
    // energy, season entries, and account_links for portal SDKs, each its own
    // table keyed by `account_id bigint REFERENCES accounts(id)`).
    // `token_hash` is the SHA-256 of the guest token; the token itself is
    // never stored.
    sql: `
      CREATE TABLE accounts (
        id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        public_id    text        NOT NULL UNIQUE CHECK (public_id ~ '^[0-9a-f]{16}$'),
        token_hash   bytea       NOT NULL UNIQUE,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )
    `
  }
]
