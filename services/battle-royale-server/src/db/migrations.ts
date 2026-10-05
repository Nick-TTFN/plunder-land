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
  },
  {
    version: 4,
    name: 'seasons',
    // Weekly seasons (decision #48 step 6, progress/seasons.ts). One entry per
    // season and account, written by the run's XP grant in the same statement
    // (`PgAccountStore.grant`); `xp` is the season's run XP, the payout's cap
    // (payout XP is not counted in it); `banked_at` is the end time of the run
    // that last raised `banked`, passed in by the server, not `now()`, so both
    // stores break ties alike. A `seasons` row is written only by the payout,
    // so its existence means "paid", and its primary key is the last guard
    // against paying twice. `name` is the sanitised name (Player.displayName,
    // never a raw one) of the run that last credited the entry, shown on the
    // public `/season` board (decision #48, 2026-10-04); kept as long as the
    // entry. Its CHECK is a loose backstop (sanitised names are at most 16
    // code points): too tight, it would fail the grant and lose the XP. New tables only: the step-5 server runs unchanged
    // on this schema during overlap and drain.
    sql: `
      CREATE TABLE season_entries (
        season_start date        NOT NULL,
        account_id   bigint      NOT NULL REFERENCES accounts(id),
        banked       bigint      NOT NULL DEFAULT 0 CHECK (banked >= 0),
        runs         int         NOT NULL DEFAULT 0 CHECK (runs >= 0),
        extractions  int         NOT NULL DEFAULT 0 CHECK (extractions >= 0),
        xp           bigint      NOT NULL DEFAULT 0 CHECK (xp >= 0),
        banked_at    timestamptz,
        name         text        CHECK (char_length(name) BETWEEN 1 AND 64),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (season_start, account_id)
      );
      CREATE INDEX season_entries_rank ON season_entries (season_start, banked DESC, banked_at, account_id);
      CREATE TABLE seasons (
        start   date        PRIMARY KEY,
        paid_at timestamptz NOT NULL DEFAULT now(),
        ranked  int         NOT NULL,
        paid    int         NOT NULL
      );
      CREATE TABLE season_payouts (
        season_start date     NOT NULL REFERENCES seasons(start),
        account_id   bigint   NOT NULL REFERENCES accounts(id),
        rank         int      NOT NULL,
        tier         smallint NOT NULL CHECK (tier IN (1, 10, 25)),
        xp           int      NOT NULL CHECK (xp > 0),
        PRIMARY KEY (season_start, account_id)
      )
    `
  },
  {
    version: 5,
    name: 'energy',
    // Plays (decision #48 step 7, progress/energy.ts): the stock and when it
    // was true; regeneration is computed on read, never written by a timer.
    // No row is a new account's stock (`ENERGY.start`), so accounts made
    // before this migration start full too. Written only inside a
    // transaction holding the row (`PgAccountStore.spend` / `refund`). A new
    // table only: the step-6 server runs unchanged on this schema during
    // overlap and drain (and charges nothing).
    sql: `
      CREATE TABLE energy (
        account_id bigint      PRIMARY KEY REFERENCES accounts(id),
        stock      int         NOT NULL CHECK (stock >= 0),
        as_of      timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `
  },
  {
    version: 6,
    name: 'stash',
    // The gear stash (decision #49, task 49-3). A row is `state` 0 stashed or
    // 1 carried; a carried row names `holder`, the boot id of the process
    // (`GearLedger`) whose memory may hold its in-world copy. A row with a
    // `rowId` in a run is only ever moved or deleted, conditionally on
    // `state = 1 AND holder = <that boot>`, never inserted; only found
    // instances are inserted, once, at the run's end (`settleGear`).
    // `rolls` is flat `[stat, q, stat, q]`, q 0..1000 (qualities, never
    // values: `utils/gear.ts`). `skill` 0 is a part. `source` is append-only:
    // 1 found, 2 merged (49-5); a later merge reroll (Q11, open) can add its
    // own columns. `gear_holders` is each live process's last heartbeat: a
    // carried row whose holder hasn't beaten for 15 minutes returns to the
    // stash at its owner's next `loadStash`. New tables only: the step-7
    // server runs unchanged on this schema during overlap and drain.
    sql: `
      CREATE TABLE stash_items (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_id  bigint      NOT NULL REFERENCES accounts(id),
        tier        smallint    NOT NULL CHECK (tier BETWEEN 1 AND 3),
        skill       smallint    NOT NULL CHECK (skill BETWEEN 0 AND 255),
        rolls       smallint[]  NOT NULL DEFAULT '{}'
                    CHECK (array_ndims(rolls) IS NULL OR (array_ndims(rolls) = 1 AND cardinality(rolls) <= 16)),
        state       smallint    NOT NULL DEFAULT 0 CHECK (state IN (0, 1)),
        holder      uuid,
        carried_at  timestamptz,
        source      smallint    NOT NULL CHECK (source > 0),
        created_at  timestamptz NOT NULL DEFAULT now(),
        CHECK ((state = 1) = (holder IS NOT NULL AND carried_at IS NOT NULL))
      );
      CREATE INDEX stash_items_account ON stash_items (account_id);
      CREATE INDEX stash_items_holder ON stash_items (holder) WHERE state = 1;
      CREATE TABLE gear_holders (holder uuid PRIMARY KEY, seen_at timestamptz NOT NULL)
    `
  }
]
