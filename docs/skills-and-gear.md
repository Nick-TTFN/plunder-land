# Skills and gear

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Skills

**Skills unlock by account level; a player equips 4 on Q W E R** (decision #48 step 4, shipped
2026-10-04). The skill ids, labels, unlock levels (Dez v1: Dash, Melee and Ranged 1, Defend 2,
Fireball 4, StoneWall 6, Icicle 9, IceBreath 11), `START_KIT` `[1,2,3,0]`, `LOADOUT_SLOTS` (1/2/3/4
loadouts per robot at levels 1/10/15/20) and `checkLoadout` are in the mirrored `utils/skills.ts`.
**Ids are append-only and are not slot indices.** A join plays `kitFor(account, robot,
start.loadout)` (`progress/loadouts.ts`): the stored row, checked against `levelOf(account.xp)`
(never `Unit.level`) at every join, because a curve change can lock what was valid when saved;
otherwise the whole start kit. A join is never refused. The server builds the 4 with `buildKit`
over `SKILL_SPECS` (`archetypes.ts`); robots carry no skills and `Player`'s default kit is the
start kit, so a path that forgets the kit fails closed. Robot and finish locks (#48 step 5) use `joinLevel` (`progress/unlocks.ts`): `levelOf(xp)`, 1 for an offline account, `Infinity` for no account (only non-strict specs reach it). `loadoutsFor` keeps locked robots and their stored rows: the account is sent only on connect, and a row saved before locks is what the robot plays once it opens. The 4 reach the client in `hello.skills`;
the client builds only its own player's skills (`Player.equip`, `skills/catalog.ts`). With no
`hello.skills` (a server from before loadouts) it plays the legacy eight on q-i; delete
`LEGACY_SLOTS`/`LEGACY_KEYS` (`net/loadout.ts`) in the release after.

**All eight have their own icon since the arena art pass** (2026-09-28; the four that had
none are still in `src/skills/placeholders.ts`, which kept its name), and the shield,
snowflake, flame, muzzle flash, icicle and both blasts are arena sprites. Still missing and
wanted: `player/magic/frame` and `player/shoot/shot` clips (Defend and RangedAttack used to
call them and only logged an error), and every unit (the drop excludes units). A name
missing from every sheet isn't a harmless blank: pixi fetches it as a URL and throws an
uncaught error on every use. `textures.spec.ts` (server) fails on any literal sprite or
animation name the client uses that isn't in one of the five sheets; names picked from a
table (`Consumable.TEXTURES`, `ItemPickup`'s `ART`, the skill icons) are not checked.

**Every area of effect is a set of hex cells, not a radius.** A unit is inside if the cell
under its centre is. `World.FIND_IN_CELLS` covers rings around a cell: melee is 2 rings
around the caster, and the fireball/icicle blast is 1 ring around **the cell of the unit
struck**, or around the last cell of its line if it struck nobody. Breath cones are `World.CONE_CELLS`: the
facing snaps to one of the six `Hex.DIRECTIONS`, and each ring is the three forward
neighbours of the ring before, so ring k has 2k+1 cells. No angle test. **Ranged is a hex
line** (`Hex.line`, mirrored): cube lerp and round from the caster's cell toward the aimed
cell, on to the range in cells (players 6 since #43, standard vision, so a player can no longer
outrange a gunner's 6-ring notice; gunner 6). It hits the first unit on those cells
(`World.FIRST_ON_LINE`), which includes one on the caster's own cell. A fixed nudge makes ties
break the same way on both sides (pinned in `hex.spec.ts`). Aiming at a cell's centre and
testing distance to the segment missed about 29% of targets 6 cells away.

**Projectiles are not solid, and have their own list.** A `Throwable` lives in
`World.PROJECTILES`, not `OBSTACLES`. When it was solid, every fireball exploded on its
caster. **Fireball and icicle step along a 10-cell hex line** (`Throwable.RANGE_CELLS`; the
skill builds it with `RangedAttack.lineOf`: through the aim, or along the hex facing;
hex-cells P3, #34). The front starts `HEAD_START` (8) thirds of a cell out and gains `STEP`
(5) thirds a tick, in integers and not scaled by dt, so it is on line index 4, 6, 7, 9, 10
after ticks 1-5 (at a non-default `TICK_MS` its speed in u/s changes). Each newly crossed
index strikes the first unit, never the owner, on that cell or a neighbour of it
(`SWATH_RINGS` 1), found through `World.UNITS` (`Throwable.findHit`): one on a line cell
before one beside the line, the earliest line cell first, then the lowest id. Reaching index
10 bursts there. Reach is 11 cells in every direction; a unit that leaves the swath before
the front arrives is not hit. Rocks don't stop it. The 1200 ms `lifetime` is still sent, but
nothing ends a projectile by time. `World.updateProjectiles` walks the list backwards and is
the **only** place a projectile is removed. Splicing from inside `explode`, which runs within
the projectile's own update, made the next projectile skip a tick. `OBSTACLES` holds
stones, portals and exits (and held world rocks, `World.isRock`, until the valleys).

**StoneWall is placed behind the caster on purpose**, to block chasers. Do not "fix" it to
the front. It fills the 3 cells directly behind (`StoneWall.cells`: the neighbours at b-1,
b, b+1, b opposite the facing), one stone per cell centre. A cell is skipped if it is off
the map, already blocked, holds a portal or exit, is a portal's arrival cell, has a live unit
on it, or is held by a mob mid-step (`StoneWall.canPlace`): a mob always finishes a step, so a
stone on its next cell would trap it. `World.BLOCKED` maps each cell to its one
blocker, not a count, so two blockers on one cell would let the first to expire unblock
the other's cell. The skip is what makes a stone's unconditional unblock safe.

## Gear

**Skill items and parts** (decision #49, live 2026-10-05 as `cb645f2`; design
`ideas/skill-items-and-stash.md` in the project memory; the stash is under Accounts). An instance is
`{ tier 1-4, skill, rolls, rowId? }`: `skill` a `utils/skills.ts` id, 0 for a part (no rolls, only for
merging); T1 one roll, T2-T3 two, T4 three, on different stats (`rollCount`); tiers are shown by
rarity name, COMMON/RARE/EPIC/LEGENDARY (`GEAR_TIER_NAMES`, `tierName`; display only, the stored
and wire number is unchanged; the client reads every tier through the mirror, no literal); each roll a stat id and a quality `q`, an
**integer 0-1000 everywhere** (database, JSON, binary), turned into a value by `rollValue`, so the
lobby and the HUD print the same number; `rowId`, the stash row it came from, is server-only.
`utils/gear.ts` is mirrored: `GEAR_STATS` (ids append-only, per-tier ranges, caps summed over both
slots), `GEAR_SLOTS` 2, `GEAR_BAG` 4, `STASH_SOFT` 12, `STASH_MAX` 100, `BRING_LEVEL` 3, and
`encodeGear`/`decodeGear`. The ranges are mirrored because the client prints values and an item
skill's cooldown, so a retune needs both deploys, client first. The drops are server-only:
caches, respawn and the part/skill mixes in `LAYERS[].gear`; mob drops by rarity (#51, l1-2) in
`MOB_GEAR_ROLLS`, on each archetype as the required `gearRolls` (a forgotten row is a type error,
not a silent no-drop). Every roll is a flat `MOB_GEAR_CHANCE` 4% on its own; rolls at T1/T2/T3 are
common 1/0/0, rare 2/1/0, epic 4/2/1, legendary 8/4/3 (the Brood's own-tier roll becomes a third
Epic one), so 0.04 / 0.12 / 0.28 / 0.60 items per kill. **The own-tier roll from Rare up is
always a skill item**; every other roll goes by the layer's `mobMix`. Broodlings, robots and the
retired grunt/gunner/boss drop nothing. **T4 (Legendary) is merge only**: never found, never
dropped, from any mob or cache. The T4 stat column and `rollCount(4)` are PROVISIONAL (l1-0).

**Stats go through the existing paths, cached once at `Player.equipGear`, nothing per tick:**
damage through the `Unit.damageScale` getter that `Skill.dealt` reads; max HP and armor
`round(base * (1 + pct/100))`, with hp and armor rising by the same delta (gear only arrives
mid-run); speed added to `maxVelocity` as a delta rounded to tenths, so a running `Slowdown` still
restores correctly and `speed` (27) carries it exactly; pickup reach `effectiveReach` (base + bonus,
at most 2, Magnet's 3 untouched). Don't declare `armor`/`maxArmor` on `Player` (the TS2610 trap
above). **A duplicate** (an item whose skill is already in the kit or the other slot) fires that
existing instance and shares its cooldown; its cooldown roll doesn't apply, its other rolls do
(Nick, #49; `DUPLICATE_CUTS_COOLDOWN` false is the whole rule).

**In the run** (49-2): natural caches per layer (`gear.caches`, no expiry) are placed one a tick
while the layer is short, and a taken one comes back after `cacheRespawnMs` on a timer owned by the
world (`CACHES_PENDING`), not refilled every tick like medkits, which would make gear unbounded. Mobs
drop by `World.createGearFrom` beside `createLootFrom`, several items per kill, each on its own
`dropCells` cell while distinct free ones remain, then on any of them; drops expire after 30 s. A skill item goes
into the first empty key (3 or 4), else the bag; a part, and everything a bot takes, into the bag;
with no room the pickup stays. Nothing moves between bag and keys mid-run (Nick, #49). Death and
disconnect drop keys and bag (`takeGear`, `rowId` kept). The HUD's keys 3-4 are gear cards
(`ui/components/gearpanel.ts`, `GearSlot` extends `SkillCard`, so touch arming works; cooldown from
the client's skill class times the roll, the kit card's for a duplicate) with roll lines on hover or
long press, and a four-icon bag. The pickup art is a placeholder (a skill icon in a tier ring, a hex
for a part).

**Merge** (`gear/merge.ts` `mergeOutcome`, 49-5): 3 stashed items of one tier. Any skill item among
them makes a skill item of the next tier with the kept input's skill and fresh rolls. Parts only: T1
makes a T2 skill item 15% of the time, T2 a T3 one 25%, T3 a T4 one 35% (`PART_MERGE_SKILL_CHANCE`
`{1: 0.15, 2: 0.25, 3: 0.35, 4: 1}`; 0.35 is #51's first value), else a part of the next tier; 3 T4
parts make a T4 skill item, always (so 81 T1 parts always reach one). 3 T3 items with a skill item
make a T4 skill item (#51, l1-2). A T4 merge with a skill item is refused: there is no tier 5.
`mergeOutcome` and the client's `mergeCheck` are written against `GEAR_TIERS`, and
`stasheditclient.spec.ts` holds them equal over tiers 1-4.
A scrap pays nothing: loot is not a currency (#48, #49). Q11, an ad-gated reroll of a merge result,
is open: not built, not ruled out.

## Mob skills

NPC attacks (#51, L1) are server-side mob skills and routines under `src/mobskills/`, never in the
mirrored `utils/skills.ts` (a mob skill there would drop as a player item: `rollGear` picks
uniformly over `SKILL_LIST`). They are hex-cell sets like every area of effect above and hit
players only, except the Broodling blast. Each one, its timings and its timer ownership: see
`docs/npcs.md` ("Attacks"). The Coil's slow is a new buff, `FieldSlow` (one per unit, refreshed
through `FieldSlow.apply`, never `addBuff`), that multiplies with the Icicle's `Slowdown`.
