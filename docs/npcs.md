# NPCs: roster, spawning, attacks and rigs

The mob roster since L1 (decision #51; tasks l1-1..l1-8, merged 2026-10-07 on local `l1`). Every
number below is **PROVISIONAL (l1-0)**: Dez's `ideas/npc-numbers.md` table, not yet accepted by
Nick. The code is the source: server-only numbers in `NPC_NUMBERS`
(`src/archetypes/archetypes.ts`), the ones the client draws in `NPC_SHARED` (mirrored
`utils/archetypes.ts`). Each block points at the other.

## The roster

Seven NPCs, archetype ids **9-15** (append-only; 6-8 stay reserved, see below):

| Id | Key | Rarity | Layers | What it does | Code |
|---|---|---|---|---|---|
| 9 | crawler | common | all, in packs | shoots like the old gunner (8 dmg / 2000 ms, 5 cells, holds at 4) | `RangedAttack` + `useSkillOnTarget` |
| 10 | kiln | rare | -1, -2 | keeps 5-6 away, lobs at the target's cell | `mobskills/kilnlob.ts` |
| 11 | reactor | epic | -1, -2 | charges, plants, bursts a 2-ring disc; contact 15 | `mobskills/reactorburst.ts` |
| 12 | coil | rare | -1, -2, as a pack escort | slowing field on a 2-ring disc, no damage | `mobskills/coilfield.ts`, `buffs/fieldslow.ts` |
| 13 | compactor | common | all | slams a 3-cell line, knocks players back 2 | `mobskills/shockwave.ts` |
| 14 | brood | legendary | -2 only | keeps 5-6 away, releases Broodlings | `mobskills/brood.ts` |
| 15 | broodling | common | never spawned by a layer | fuse, primes when adjacent, blasts | `mobskills/broodling.ts` |

`rarity` (`'common' | 'rare' | 'epic' | 'legendary' | null`) and the optional `attack` cell shape
(`lob {range, rings}`, `disc {rings}`, `line {length}`) are mirror fields, so the client draws
and threat-marks the cells the server damages (`vfx/cells.ts` `attackCells`/`attackReach`,
checked against the server by `effectcells.spec.ts`). Contact damage is 0 for every NPC but
the Reactor.

**grunt, gunner and boss (6-8) stay in `ARCHETYPES` and the mirror** (ids append-only; about
25 specs use them as test mobs; `Mob`'s default archetype is still grunt; the client keeps
their looks for an old server during a drain), but **no layer spawns them**.

**Mob skills are server classes only; never add one to the mirrored `utils/skills.ts`**:
`rollGear` picks uniformly over `SKILL_LIST`, so it would drop as a player item. A skill that
needs numbers takes them through a small subclass (`KilnsLob`, `CompactorsShockwave`), because
a `SkillClass` gets only its owner; `SkillSpec`/`buildSkill` stay as they were.

## Spawning: packs and singles

`LAYERS[].mobs` is built by `npcPopulation(i)` from `NPC_NUMBERS.layers` (top first): 5 Crawler
packs a layer; Compactors 8/7/4; Kilns 0/4/6; Reactors 0/2/2; Brood 0/0/1. An entry is a
`LayerSingle` or a `LayerPack` (`isPackEntry`): `{ pack: crawler, sizes, escort?: coil,
escortShare }`, sizes 2/3/4 at 35/40/25 %, a Coil escort on a pack with share 0 / 0.6 / 1 by
layer (none on layer 0, no free Coils).

- A pack spawns on one free cell and its free neighbours (`mobCellFree`), **whole or not at
  all** (10 tries), at most one pack per entry per tick (`World.spawnPack`, `placeMob`).
- Members share one home (`MobPack.join` sets each `GuardPosition.homePosition`) and one
  aggro: `GuardPosition.provoke` provokes live pack mates too (pack mates hitting each other
  alert nobody: the instance `provoke` ignores non-player attackers).
- **`refillLayer` counts a pack entry by live packs (`packsAlive`) and a single entry by mobs
  with no `pack`**, `!destroyed` in both. A pack is replaced only when all its members are
  dead, the escort Coil included (so a lone surviving Coil holds the pack open).
- `World.spawnCell`'s hazard is now `World.isSpawnHazard`: rarity epic or legendary (Reactor,
  Brood), plus the retired boss.

`roster.spec.ts` ticks a real world for two simulated minutes per layer and holds all of the
above.

## Kills, XP, loot and drops

- **Redis `stats-<id>`** (consumed, additive): each NPC credits `mobKills` and its
  `<rarity>Kills` (`commonKills`, `rareKills`, `epicKills`, `legendaryKills`; `npcKillStats`).
  **`bossKills` is frozen**: no L1 row credits it; kept readable, documented in place on
  `KillStat` and `Stats`.
- XP (`PROGRESSION.kills.mob`, `progress/xp.ts`): crawler 1, broodling 0, compactor 2, kiln 3,
  coil 3, reactor 10, brood 12; grunt/gunner/boss entries kept; `mobDefault` 2, `mobCap` 20.
- Loot before the layer multiplier: 25 / 50 / 100 / 75 / 500 / 800, Broodling 0.
- Gear drops by rarity (`gearRolls`, required on every row): see "Gear" in
  `docs/skills-and-gear.md`. Broodlings drop nothing.

## Attacks

Every NPC attack is a hex-cell set (`FIND_IN_CELLS`), never a radius, and **hits players only**
(Q6), except the Broodling blast, which hits mobs too (Nick: "can hurt nearby mobs"). Every
victim loop skips `destroyed` and exited players, and kills go through the attacker's `onKill`
(`killedBy` 'mob'). Effect types are in `docs/wire-format.md` ("Effects", 9-19). Art for every
effect is a placeholder (BACKLOG "Art pass: NPC effects").

**Timer ownership is deliberate and differs by NPC** (see `docs/server-invariants.md`): the
Kiln's lob in flight has **no owner** and lands after the Kiln dies, as a thrown bomb does; the
Reactor's burst, the Compactor's slam, the Coil's field, the Brood's release clock and the
Broodling's fuse and tell are **owned by the NPC**, so its death cancels them.

**Kiln lob** (l1-4). `GuardSpec.retreat { min 5, max 6 }`: below `min` it backs away
(`stepGoal.away`, a greedy mode of `Unit.chooseStep`: the furthest enterable neighbour, staying
put with `stepBlocked` if none is further), holds within the band, closes beyond `max`. It
lobs within 7 cells (`attack.range`) at the target's cell at cast time, every 3500 ms: effect
9 (`effectAt`, lifetime = flight 1250 ms), then an ownerless timer lands effect 10 and 30 to
every player on the cell + 1 ring. Dodge by moving. A cast with no aim, off the map or out of
range is refused without spending the cooldown. Nick still owes the band (5-6 here, his
earlier "7-9").

**Reactor burst** (l1-5). Chases (standoff 0); when its target is within 2 rings of
`stepTo ?? cell` it **plants** (it clears `stepGoal` every tick after the guard until the settle
ends; the step in progress finishes). Effect 11 (activate, 1000 ms), then at +1000 effect 12
(release) and 4 pulses at +1000/1250/1500/1750 of 25 to each player on the 2-ring disc, settle
to +2350 (lands on the +2500 tick), cooldown 2000 ms. Every timer is scheduled at the plant by
offset (`Timers.schedule(offsetMs, ...)`), owned by the Reactor: killed in the tell or the
release, nothing more happens. Contact 15/s stays on in every phase. The burst is not
retargeted if the target walks off.

**Coil field** (l1-3). When the guard's target is within 2 rings it charges, at most every
6000 ms start to start, and stays planted for tell 1500 + hold 1500 + cool 700 (the clip's
timings). Effect 13 goes out **once at the charge start** with lifetime tell + hold (the only
way the tell reaches the wire; a viewer arriving mid-charge sees nothing but can still be
slowed). On each hold tick one `FIND_IN_CELLS` on `stepTo ?? cell` slows every live player on
the disc until hold end + 500. **`FieldSlow`** (`buffs/fieldslow.ts`): one per unit through
`FieldSlow.apply`, which refreshes the end (never `addBuff`, which stacks and would halve speed
again every tick), players only, x0.6 rounded to tenths so `speed` (27) carries it exactly,
gives back exactly what it took (`declare applied`). Multiplies with Icicle's `Slowdown` (x0.3
together); the speed while both run and one ends is not exactly the other's factor, and heals
when the second ends. Effect 16 (slowed) goes to the victim when applied, again only past half
its time. An Icicle on a Coil-slowed player gets `Throwicicle`'s +10 "already slowed" bonus
(noticed, for Dez). Escort: standoff = the field's rings, home shared with the pack.

**Compactor shockwave** (l1-6). Cast within 2 rings, every 3600 ms. The line is fixed at the
cast: from the Compactor's cell (or the cell it is stepping into), along the aim snapped to one
of six (`World.FACING_INDEX`), 3 cells (`attack.length`), cut at the map edge; valleys, walls and
stones don't stop it. Effect 14 on the Compactor, aimed at the **uncut tip**. It holds still for
the wind-up (clears `stepGoal`), and the hit lands 1215 ms later (on the 1250 tick) on a timer
it owns: 35 to each live player on the line, then each survivor gets
**`Player.knockback(direction, 2)`**: a neighbour walk stopping before any cell the player
`blocks` (Hopper passes walls and stones), any gate cell and any arrival cell; with no free cell
nothing happens (no stop, no effect). Otherwise `stop()`, `connection.lastWaypoints = []`, the
landing centre through the setter, and effect 15 to the victim's holders including itself. The
client mirror is in `docs/movement.md` ("Knockback").

**Brood and Broodlings** (l1-7). The Brood keeps the Kiln's 5-6 band. Its release clock
(`BroodRelease`, a `Timers` entry owned by it) arms the tick it has a live target; each 4000 ms
beat re-arms while the target lasts and releases one Broodling if fewer than 3 it released are
alive, on the free neighbour (`mobCellFree`) nearest the target, via `World.addUnit(World.MOBS,
...)`, then effect 19 (`effect` on the Brood, aimed at the new cell, lifetime 1100 = the spawn
clip). No target at a beat: not re-armed. Brood death stops the stream; released Broodlings keep
their fuse; socketed children are client-only art.

A **Broodling** (`BroodlingFuse`) lights a 6000 ms fuse in its constructor (timer owned by it),
chases at 130 and goes off three ways, all the same blast (25 to every live unextracted player
**and mob** on its 1-ring disc but itself, effect 18):
- the fuse ends: where it stands;
- a live player within 1 ring of `stepTo ?? cell`: effect 17 (primed, 500 ms), held in place,
  blast on the primed cell 500 ms later;
- **any damaging hit** (`Mob.onHit`, the hook only the Broodling sets): at once, in place; the
  hit returns true, so the hitter is credited the kill (`mobKills` + `commonKills`, 0 XP). A
  0-damage hit does nothing.

`detonate` sets `detonating`, hp 0 and `destroy()` **before** the effect and damage, so a chain
(a blast that hits another Broodling sets it off through its own `hit`) finds it dead, frees
each id once and credits nobody twice. Blast kills credit nobody; a player killed by one gets
`killer` = the Broodling, `killedBy` 'mob'. StoneWall stones survive the blast (the bomb breaks
them; a feel call for Dez). The remaining fuse goes out in **`lifetime` (9)** on the create
(see `docs/wire-format.md`).

## Client: rigs and sprites (l1-8)

NPCs are drawn by **`NpcSprite`/`NpcRig`** (`plunder-land-client/src/npcs/`), siblings of
`RobotSprite`/`RobotRig`, not extensions: they share only pure helpers (`peep/rig.ts` matrix
maths, `layShadow`, `RobotSprite.SCALE` and pace constants, `SHOT.fire`). One hand port per NPC
in `src/npcs/<key>/rig.ts` of the Codex package's evaluator, as a draw list (images placed by an
art-pixel to rig-unit matrix, plus ellipses, lines and polygons). `NPC_RIGS` is the table.
Ported: **Crawler** (`crawler-animations-v4`) and **Broodling** (`npc-refinements/broodling-v3`);
the other five are l1-9. Packages stay in gitignored `codex_output/`; only fixtures and sheets
are committed.

- **Tools** (run from the main checkout, which has `codex_output/`; pass the package path in a
  worktree): `tools/npc-rig-sync.mjs <npc> [package]` writes
  `services/battle-royale-server/src/utils/npcrigs/<npc>.fixtures.json` (every package pose
  sample re-evaluated with the package's own module, plus extras); `tools/bake-npc-atlas.py
  <npc> [package]` bakes `assets/res/npc-<key>.png/json` from `parts.json` at the largest drawn
  size per part, pngquant + oxipng. `npcrigs.spec.ts` (server) checks each port against its
  fixtures within the package tolerance, the clip table against the manifest, and that every
  drawn art is a sheet frame (`textures.spec.ts` sees only literal names). Fixtures over ~1.5 MB:
  thin the samples, don't lower the rounding (Crawler's is 1.1 MB, spec-only).
- **Scale:** px per rig unit = `RobotSprite.SCALE` x the NPC's multiplier (Crawler 0.89,
  Broodling 0.94; Nick's Q3 on the anchor is open).
- **Clips:** idle/move by movement, paced like robots; Crawler `fire` on effect 3, started at
  `event - SHOT.fire` so its fire event meets the beam, beam from the sensor (`Mob.eyeGlobal`);
  `hit` on an hp drop plus a 0.12 s red tint (Crawler; the Broodling has no hit clip); death
  never replaced, held, removed after `duration - from + 0.5` s. Broodling: `spawn` (emerge) only
  on a real release, picked by effect 19 (`vfx/broodpick.ts` `pickReleased`: a live Broodling on
  the Brood's layer created in this frame, nearest the release cell within 3 cells; a late
  viewer sees none); primed tell = `detonate` from 0.85 s (`roles.prime`), clamped short of the
  blast until the destroy arrives, which carries on from 1.35 s; the cord length is the remaining
  fuse (`clamp(left / 3000, 0.25, 2)`, from the create's `lifetime`). The code-drawn cord is only
  for the `mob/mob` fallback.
- `objects/mob.ts` uses `NpcSprite` when `lookFor` names an NPC rig whose sheet loaded (sheets
  load in the background from `Game`'s constructor), else `mob/mob`: old ids and unknown ids
  unchanged. HP bar 60 wide for epic and legendary (and the retired boss). Threat rings include
  NPC attacks (`attackReach`: a Kiln shows 8 rings); whether a lob should be marked by its reach
  is Dez's to propose after play. `ui/elements/threatmarker.ts` `threatRings` has no caller
  left (l1-9: delete it or route `game.ts` through it).
- Unmeasured: client cost of many rigged NPCs in view (each poses, draws and, with shadows on,
  runs its own `AlphaFilter`); check the FPS overlay on a crowded -1/-2 before release.
- Known placeholder behaviour: a released Broodling slides for about 1.5 s while it unfolds
  (the server moves it at once); options are with Dez/Nick for l1-9.
