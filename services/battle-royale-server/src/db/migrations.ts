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
  },
  {
    version: 2,
    name: 'account_progress',
    // XP per account (decision #48 step 3). The level is derived from `xp` by
    // the curve in progress/xp.ts and never stored, so a curve change
    // re-levels everyone (Nick, #48 build call 6). A row appears with the
    // account's first grant; no row reads as 0. Granted by one atomic upsert
    // (`PgAccountStore.grant`).
    sql: `
      CREATE TABLE account_progress (
        account_id bigint      PRIMARY KEY REFERENCES accounts(id),
        xp         bigint      NOT NULL DEFAULT 0 CHECK (xp >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `
  },
  {
    version: 3,
    name: 'loadouts',
    // Skill loadouts (decision #48 step 4): 4 skill ids (utils/skills.ts) per
    // account, robot and loadout index, written by one upsert
    // (`PgAccountStore.saveLoadout`). `robot` is the archetype key, as
    // `start_requested.robot` and the lobby name it. The CHECKs are a
    // backstop: the server checks a loadout before every write and again at
    // every join (`checkLoadout`), because a level can drop under a curve
    // change. No finish column: finishes stay in `start_requested.finish`
    // (48-4 task, "Finishes stay out of loadouts"); adding one is additive.
    sql: `
      CREATE TABLE loadouts (
        account_id bigint      NOT NULL REFERENCES accounts(id),
        robot      text        NOT NULL CHECK (robot ~ '^[a-z]{1,16}$'),
        slot_index smallint    NOT NULL CHECK (slot_index >= 0 AND slot_index < 16),
        skills     smallint[]  NOT NULL CHECK (array_ndims(skills) = 1 AND cardinality(skills) = 4),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, robot, slot_index)
      )
    `
  }
]
