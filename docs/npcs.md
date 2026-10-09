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

## Bodies (ring footprint)

#52 open item 6, option B (`ideas/ring-footprint-npcs.md`), merged 2026-10-09: **the Reactor and
the Brood occupy 7 cells**, the cell under their centre and its ring. `ArchetypeInfo.bodyRings`
(mirrored `utils/archetypes.ts`, `0 | 1` on every row, 1 on those two; not on the wire, no
PROTOCOL bump), read through the `Unit.bodyRings` getter. Everyone else is still one cell.

- **Hit on any of the 7 cells by a player's attack**: `FIND_IN_CELLS` with `Mob` in the mask
  (melee, bomb, fireball/icicle blast, Broodling blast), `FIRST_ON_LINE` (ranged: the body is on
  the line at its earliest cell), `Throwable.findHit` (a swath ranks a body by its best cell),
  `SectorArea.overlaps(value, unit)` (breaths, damage and provoke). Counted once. Players-only
  queries (every NPC attack, `Mob.touch`, the shockwave's `UNITS_ON`) never look, and
  `NEAREST_IN_CELLS` (guard acquire, bot scuffle) measures from the centre, deliberately.
- **Kept off by other mobs**: `mobHolds` answers for ring cells, so a mob stalls on ring 2; a body
  steps or spawns only where all 7 target cells are `mobCellFree` (`mobFits`, from `mobCanEnter`
  and `spawnMob`), and holds both bodies (10 cells) while stepping (`claimStep`). So a body never
  stands on a blocked, gate or arrival cell, can't cross one-cell valley bridges or wall gaps, and
  stalls more on greedy steps. Packs are never bodied (`spawnPack` relies on it). StoneWall refuses
  ring cells (through `mobHolds`).
- **Players walk through a body**, as through any mob (contact still lands from its ring).
- **Its own reach is unchanged from its centre**: the Reactor's 2-ring burst is 1 ring past its
  body; the Brood's 5-6 band is 4-5 from its edge; player spawn clearance (3) is 2 from the edge.
- The Brood was drawn at 3.2 by lane 4 and is **2.5** since this change (about 3 cells wide), to
  sit on its 7 cells. Interest and fog still count from the centre (plan item e, a follow-up).

Client: `vfx/cells.ts` `firstOnLine` takes `Body.rings` and `lineIndexOf`; a player's beam ends on
the body's first cell on the line, kept at that offset while the body moves during the eye's
charge (`vfx/rangedattack.effect.ts`). A mob's shot ignores rings (it passes mobs).
`effectcells.spec.ts` puts a body in the crowd on every other trial of its 400-shot sweep. During a
deploy the beam and the server can disagree about a ring hit (either direction, until the client
reloads); accepted as cosmetic, the damage number is the authority. Specs: `objects/bodies.spec.ts`.
Tickbench (400 players): about +0.05-0.1 ms a tick, +1-3 %, under half of it the lookups.

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
- **A mob killed by a Broodling's blast is credited to the player whose damaging hit set that
  Broodling off** (decisions.md "Brood stream numbers", 2026-10-09; mechanism under "Brood and
  Broodlings" below). **Validity boundary:** from the build after `e4b54dd`, the Redis `kills`,
  `mobKills` and `<rarity>Kills` keys and GA `run_end` `kills` include those blast kills (the
  same meaning, "every credited kill", with more kills credited); before it, a mob a blast killed
  was credited to nobody. Compare kill counts across that build by date. No param or key was
  added or renamed.

## Attacks

Every NPC attack is a hex-cell set (`FIND_IN_CELLS`), never a radius, and **hits players only**
(Q6), except the Broodling blast, which hits mobs too (Nick: "can hurt nearby mobs"). Every
victim loop skips `destroyed` and exited players, and kills go through the attacker's `onKill`
(`killedBy` 'mob'). Effect types are in `docs/wire-format.md` ("Effects", 9-19). The art is
the `npc-fx` sheet (l1-11, PROVISIONAL until Nick reviews it; `docs/art-pipeline.md`), drawn by
`vfx/npcfx.ts` (`stampCells` one ground decal per server cell, `standAt`, `warnCells`,
`burstCells`, `hitSpark`) on the same cell sets the placeholders drew: 9 landing centre and ring
plus the slug and its shadow, 10 impact cells and burst; 11 warning, 12 release cells and a core
flare on the Reactor's rig; 13 warning through the tell, then pulse cells and burst over the hold;
16 a slow-status loop on the victim; 14 warning through the wind-up, then wave cells chained 0.25 s
apart along the line and a shoe puff; 15 a skid under the victim; 17 warning, 18 scorch cells and
burst; a hit spark on every mob or player damage. **The Kiln's landing warning stands in for every
tell (11, 13, 14, 17)**: the package has no tell art (Beck's call, kept provisional for Nick).
Effect 19's pod (thrown from the Brood to the cell) has no package art and keeps its placeholder;
since the Brood stream it is drawn only when no Broodling is launched off a socket (see "Loaded +
launch" below); the cell flash always shows. Before the sheet loads,
cell sets fall back to `CellHighlight` and standing art is skipped.

**Wind-up holds** (#52 lane 2, Dez's `ideas/npc-windup-holds.md`, accepted 2026-10-09): an NPC
that would otherwise slide through its attack clip **comes to rest, casts, then stands still**.
`UseSkillOnTargetSpec.holdMs` (Crawler `NPC_NUMBERS.crawler.shotHoldMs` 500, Kiln
`kiln.lobHoldMs` 750): once the cast is due, a mob mid-step clears `stepGoal` so the step lands
and no new one starts, casts on the first tick at rest, and clears `stepGoal` every tick until a
`holdMs` timer it owns fires. Without `holdMs` (gunner, boss) the routine is unchanged. The Brood
(`brood.release.holdMs` 500): a beat at rest releases at once; a beat mid-step under the cap sets
`pending`, and the release runs on the first tick at rest after re-checking target and cap; the
clock re-arms at the beat, so the 1000 ms cadence holds on average. At 1000 ms a release that
waited for a step can be followed by the next beat's 250-500 ms later, inside its hold: **a
release inside a hold restarts it** (one `holdTimer`, cancelled on each release, owned by the
Brood), so the older timer cannot end the newer hold (`windupholds.spec.ts`, chased Brood). The
Compactor
(`compactorShockwave.holdMs` 1750) still plants at the cast and holds until the later of its
wind-up and the timer. A new Broodling stands `broodling.fuse.emergeMs` (1500) from its release
(`emerging`), and can still be primed, shot and chain-blasted meanwhile. Each hold is long enough
for the client's catch-up lead to be spent before the NPC moves again against the 500 ms ceiling
on `interpolationDelay` (rest-first: hold + 250 > 500; the Compactor: hold > 500;
`windupclient.spec.ts`), and each clip's wind-up event falls inside its hold. Measured cost (Archie, lanes 2-3 review): a held Crawler averages ~70 u/s,
so a player retreating radially above ~70 u/s makes it fall out of range and re-close; at a
sustained 80 u/s it fires about half as often, at 88-90 almost never (a cliff, not a slope). One
Coil slow (2 s at most) does not reach it. Levers are Dez's (shorter hold, faster chase).

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

**Brood and Broodlings** (l1-7; the Brood stream, Nick 2026-10-09). The Brood has 550 hp (400
until Dez's `ideas/brood-stream-numbers.md`) and keeps the Kiln's 5-6 band. Its release clock
(`BroodRelease`, a `Timers` entry owned by it) arms the tick it has a live target; each 1000 ms
beat (`release.intervalMs`; 4000 until the Brood stream) re-arms while the target lasts and
releases one Broodling if fewer than 6 it released are alive (`release.cap`; 3 before), on the free cell (`mobCellFree`) **on ring `bodyRings + 1`** (ring 2, just outside its
7-cell body; see "Bodies") nearest the target, ties in `World.ringCells` order, via
`World.addUnit(World.MOBS, ...)`, then effect 19 (`effect` on the Brood, aimed at the new cell,
lifetime 1100 = the spawn clip, so each 1 s release restarts the Brood's `spawn` clip 0.1 s
before its end). No free ring-2 cell: the beat is skipped, the clock keeps going and the next
beat tries again (ring 2 has 12 cells, so six live children never fill it alone). No target at a
beat: not re-armed. Brood death stops the stream; released Broodlings keep their fuse. A
Broodling going off on its release cell hits the Brood (blasts hit mobs): shooting the eggs next
to it is the intended counterplay, and most of the Brood's damage at 1 s (Dez's measurements in
the idea file). Measured, not played (Beck's handoff, `tasks/brood-stream.md`): about one release
a second, in pairs 250-500 ms apart when chased; a chased Brood stands about half the time and no
longer keeps its band; the cap is in effect fuse-bound (`fuseMs` 6000 / 1000).

A **Broodling** (`BroodlingFuse`) lights a 6000 ms fuse in its constructor (timer owned by it),
chases at 130 and goes off three ways, all the same blast (25 to every live unextracted player
**and mob** on its 1-ring disc but itself, effect 18):
- the fuse ends: where it stands;
- a live player within 1 ring of `stepTo ?? cell`: effect 17 (primed, 500 ms), held in place,
  blast on the primed cell 500 ms later;
- **any damaging hit** (`Mob.onHit`, the hook only the Broodling sets): at once, in place
  (`detonate(true)`); the hit returns true, so the hitter is credited the kill (`mobKills` +
  `commonKills`, 0 XP). A 0-damage hit does nothing.

`detonate` sets `detonating`, hp 0 and `destroy()` **before** the effect and damage, so a chain
(a blast that hits another Broodling sets it off through its own `hit`) finds it dead, frees
each id once and credits nobody twice. **Blast credit** (Brood stream numbers, 2026-10-09,
reversing #51's "credits nobody" for mobs): a blast set off by a damaging hit keeps the mobs it
killed in the Broodling's `Mob.blastKills`. The blast runs synchronously inside that hit, so the
list is there when the hitter's own `onKill(broodling)` runs straight after (every damaging
player path does: ranged, melee, fireball, icicle, bomb); **`Player.onKill` takes the list off,
then credits each mob through itself** (`kills`, the run's tally and XP, Redis keys, `killer`).
A chain flows to the original player (a Broodling the blast set off is one of its kills, and
crediting it credits its own list). `Unit.onKill` passes nothing on, so a blast set off by a
mob's hit, an area tick (no `onKill`), the fuse or the tell credits nobody; after a mob's hit or
an area tick the list stays on the dead Broodling, unread (a destroyed Broodling's `hit` never
returns true again) and collected with it. A player killed by a blast still gets `killer` = the
Broodling, `killedBy` 'mob', credited to nobody. A shooter killed by the blast they set off is
still credited the Broodling and its mob kills, as any kill landing after a death: Redis keys
and `killer`, too late for that run's XP and `run_end`. StoneWall stones survive the blast (the bomb breaks
them; a feel call for Dez). The remaining fuse goes out in **`lifetime` (9)** on the create
(see `docs/wire-format.md`).

## Client: rigs and sprites (l1-8, l1-9, #52)

NPCs are drawn by **`NpcSprite`/`NpcRig`** (`plunder-land-client/src/npcs/`), siblings of
`RobotSprite`/`RobotRig`, not extensions: they share only pure helpers (`peep/rig.ts` matrix
maths, `layShadow`, `RobotSprite.SCALE` and pace constants, `SHOT.fire`). One hand port per NPC
in `src/npcs/<key>/rig.ts` of the Codex package's evaluator, as a draw list (images placed by an
art-pixel to rig-unit matrix, plus ellipses, lines and polygons). `NPC_RIGS` is the table.
**All seven are rigged**: **Crawler** (`crawler-animations-v4`) and **Broodling**
(`npc-refinements/broodling-v3`) in l1-8; **Reactor** (`reactor-v6`), **Compactor**
(`compactor-v4`), **Kiln** (`kiln-v3`), **Coil** (`coil-v5`) and **Brood** (`brood-v15`) in
l1-9. The last five are **PROVISIONAL**: delivered, not yet approved by Nick, so expect a re-sync
and re-bake after his art review (marked in `NPC_RIGS`, each `rig.ts` header and the tools).
`mob/mob` is only the fallback before a sheet loads, and for the retired ids. Packages stay in
gitignored `codex_output/`; only fixtures and sheets are committed.

- **Tools** (run from the main checkout, which has `codex_output/`; pass the package path in a
  worktree): `tools/npc-rig-sync.mjs <npc> [package]` writes
  `services/battle-royale-server/src/utils/npcrigs/<npc>.fixtures.json` (every package pose
  sample re-evaluated with the package's own module, plus extras); `tools/bake-npc-atlas.py
  <npc> [package]` bakes `assets/res/npc-<key>.png/json` from `parts.json` at the largest drawn
  size per part, pngquant + oxipng. `npcrigs.spec.ts` (server) checks each port against its
  fixtures within the package tolerance, the clip table against the manifest, and that every
  drawn art is a sheet frame (`textures.spec.ts` sees only literal names). Fixtures over ~1.5 MB:
  thin the samples, don't lower the rounding (Crawler's is 1.2 MB, spec-only). The Reactor's was
  2.3 MB in full, so the sync tool keeps every 2nd walk, 2nd hit and 3rd fall_apart sample along a
  (time, base) diagonal, which keeps every package time and every base (1.07 MB); every package
  sample is still checked against the package's module at sync. The Compactor's fixture (0.97 MB)
  **leaves out 68 package samples** (hit and fall_apart from the controller's run pose at 1.3 s):
  their base comes from the package's stateful `NpcController`, which is not ported (the game
  plays stateless clips, as the robots do); extras from stateless run bases stand in for them.
  Kiln, Coil and Brood fixtures (0.79, 0.36 and 0.88 MB) needed no thinning. The Crawler's
  and Kiln's fixtures also carry samples at the game's stride (20 and 24, see "Gait"), made by
  the sync tool from the package's own module with its exported `config.stride` patched and
  restored; the spec runs them through `<NPC>_RIG.pose`, the game path.
- **Kiln flame and Brood lamps are drawn in code, not baked**: the packages ship them as frame
  atlases far too large to ship (the Kiln's 18 at 1728x3072), which are the packages' own effect
  code rasterised. The ports draw that code's shapes at the frame the package would pick (the
  Kiln's phase to 1/30 s and charge in eighths; the Brood's emission at 1/256), radial gradients
  as flat approximations (`approx`, not compared). They run on the sprite's age
  (`NpcPoseOptions.clock`), which never resets with the clip. **Every sprite's age starts at 0 and
  every Brood uses one seed**, so units first seen together flicker in step (l1-9 F3, open).
  `NpcImage.effect` (emission layers: never cast, never tinted) and `blend: 'screen'` (the Coil's
  bloom). The Coil's cooled body is drawn over its body at `dark` instead of the package's
  offscreen mix: identical where both are opaque, a faint halo (alpha 1-10) stays until `dark`
  reaches 1. Brood v15 includes no Broodlings (`includedBroodlings: false`,
  `externalBroodlingLaunches: true` in its `animation-contract.json`) but names three visible
  socket anchors, `crown`, `left`, `right`; the game draws and launches its own ("Loaded + launch").
- **Draw items** beyond images and shapes: an image may carry `alpha` and `contact` (a painted
  contact shadow, drawn in turn, never cast); **`NpcMasked`** is a group of images seen only
  through a mask image's alpha (the package composites offscreen with `destination-in`; the
  Reactor's core through its aperture), drawn as a container with a sprite mask, never cast.
- **Draw-time crops.** An image with a clip uses its band frame (`<art>-<top row>`, the Crawler's
  shell) when the sheet has one, else is cut from the art's frame at draw time
  (`NpcSprite.cut`: the Compactor's sliding shaft and its front legs' roots), snapped to whole
  texels and cached in `NpcSprite.cuts` by frame name and texel rectangle. **Bounded by the art,
  not by play**: a sliding crop makes at most its texel length + 1 entries, a fixed crop one (37
  today: 36 for the 7x35-texel shaft, 1 for a leg root, shared by every Compactor). **Never
  evicted**, by decision; each entry holds its sheet's `baseTexture`, so whoever adds sheet
  unloading must clear this map too.
- **Scale:** px per rig unit = `RobotSprite.SCALE` x the rig's `sizeScale` (Nick's size review,
  #52): Crawler 1.31, Broodling 1.49, Compactor 1.78, Kiln 1.65, Coil 2.32, Reactor 2.92, Brood
  2.5 (3.2 in the review, cut for its 7-cell body, "Bodies"). The bake tool's `size_scale` must
  match: **`npcrigs.spec.ts` holds every NPC and robot sheet's `meta.texelsPerUnit` to its rig's
  size** (and lobby sheets to one shared density), so a resize without a re-bake fails there
  instead of drawing a soft or oversampled sheet.
- **Hits are an overlay, never a clip** (#52 lane 1, `vfx/hitoverlay.ts` `HitOverlay`, pixi-free,
  shared with robots): on an hp drop, a 0.12 s tint flash (`0xff6a5a`) and a sideways jolt of the
  drawn rig (3 px decaying to 0 by 0.2 s, against the sign of x of its action's aim or else its
  direction; the unit's position never moves), at most once per 0.45 s (`RETRIGGER_S`, so tick
  damage flashes every other tick), plus a hit spark. Gait, idle and attacks run on under it; a
  death clears it. The packages assume a still body for their hit clips, and the server never
  stops a unit for a hit, so a hit clip slid. `roles.hit` is kept as data only (never played), so
  the ports and fixtures still name and check it; the old `refusesHit`/`holdGaitOnHit` flags are
  gone. `death.fromAction` (Kiln, Coil, Compactor, Reactor, Brood): the death starts from the pose
  shown, an attack's included, rather than the last idle/move pose.
- **Actions yield to movement** (#52 A1, `yieldsToMovement`, read while `moving`): every clip is
  authored with the feet planted, so an attack past its `roles.attack.event` ends when the unit
  moves: Crawler `fire` 0.34 (its fire event), Kiln `fire` 0.58 (`LAUNCH`), Brood `spawn` 0.18
  (`SPAWN_EVENT`), Coil `charge` 3.0 (`CHARGE.holdEnd`, the server's hold end), Reactor `activate`
  1.0 (`release_start`), Compactor `fire` 1.215 (`IMPACT_TIME`); the Broodling's spawn at
  `spawn.ready` 2.8. Before that moment it plays on; a death and a prime never yield.
- **Gait** (#52 lanes 3-4, PROVISIONAL): without `NpcRig.gait` a rig's move loop runs at
  `RUN_RATE x pace`, the same whatever its stride, and its planted feet slid 88-99 %. With
  `NpcGait { groundSpeed, period, maxSteps, minPace, groundTilt }`, `gaitClock` derives the loop's
  rate from the stride's sweep and `sizeScale` (ground speed / (`groundSpeed` x `SCALE` x
  `sizeScale`), so a resize needs no gait edit), capped at `maxSteps` (6) steps a second per leg
  east-west, then times `stretch`: `gaitDirection` scales the direction's y by `TILT /
  groundTilt` so the stride runs along the motion as drawn, and the loop runs up to 1.36x faster
  north-south. **So "6 steps/s" is an east-west cap: the capped rigs step about 8.2 a second going
  north or south.** `minPace` 0.2 replaces the shared 0.5 floor, so idle legs aren't too fast.
  Gaits: Crawler stride 60 (package 20) and Kiln 26 (package 20), both ports taking a `stride`
  option with run speed scaled so lean and bob are unchanged; Compactor, Reactor and Brood at their
  package strides, which leg reach limits (a longer one needs art, not a rate). **Coil and
  Broodling have none** (planted would need 23 and 46 steps/s at chase). Above the cap the feet
  slide the rest along the motion only (Compactor about 42 %, Reactor 39 % at chase; the Brood at
  2.5 about 10 % at 60 u/s); `npcrigs.spec.ts` measures planted-foot velocity from each gaited
  rig's real pose in 7 directions and holds each `period` to the loop's real step cycle.
  `tools/foot-slide.cjs` measures slide per rig and direction, and guards the sprite's clock
  line, which the spec cannot run (pixi).
- **Attack clips on effects** (l1-9): `Mob.playAttack(leadMs, toward?)` starts the attack clip so
  its event lands `attackLead(event, leadMs)` seconds later. The wire floors an effect's lifetime
  to 100 ms, so when the clip's own event falls inside that tenth after the lifetime it is taken
  as exact (the Compactor's impact 1215 ms arrives as 1200), else the lifetime as received (a
  retuned server). Effect 14 starts the Compactor's strike (`fire`) aimed at the tip, impact on the
  server's hit; effect 11 starts the Reactor's `activate` with the tell's lifetime, so its release
  event lands with effect 12, and effect 12 restarts it with lead 0 (back in step, or the start
  for a viewer who missed the tell). Effect 13 starts the Coil's `charge` with the pulse's
  lifetime (3000 ms, so it starts at 0 and the hold ends with the server's field). **Effects 9 and
  19 play from t = 0** (`Mob.playAttackFromStart`, #52 lane 2), since the server now holds the
  Kiln and the Brood still from the cast: the Kiln's 0.58 s gather and the Brood's 0.18 s wind-up
  show on a still body, and the Brood's `spawn` ends with effect 19's 1.1 s lifetime. The Kiln's
  slug stays in the Kiln until the clip's launch, then flies the time left (`vfx/kilnflight.ts`,
  pixi-free), landing at the marker's end (1200 ms on the client, the wire's floor of 1250, as
  before), so the dodge window is unchanged; without a rig it flies the whole time, and a Kiln seen
  to die before its launch throws no slug.
- **Catch-up on planting effects** (#52 S1, `Unit.catchUpNow`, `objects/track.ts` `CatchUp`): a
  remote unit is drawn about `interpolationDelay` behind the server, so a planted clip would start
  where it was, then slide to where it is. On effects 3 (a mob's shot only), 9, 11 (not 12), 13,
  14, 17 and 19 that one unit's render clock is run onto its newest state over 100 ms, along its
  real track, before the clip starts. Mechanism in `docs/movement.md`.
- **Clips:** idle/move by movement, paced like robots; Crawler `fire` on effect 3, started at
  `event - SHOT.fire` so its fire event meets the beam, beam from the sensor (`Mob.eyeGlobal`);
  the hit overlay and a spark on an hp drop (above); death
  never replaced, held, removed after `duration - from + 0.5` s. Broodling: `spawn` (emerge) only
  on a real release, picked by effect 19 (`vfx/broodpick.ts` `pickReleased`: a live Broodling on
  the Brood's layer created in this frame, nearest the release cell within 3 cells; a late
  viewer sees none); primed tell = `detonate` from 0.85 s (`roles.prime`), clamped short of the
  blast until the destroy arrives, which carries on from 1.35 s; the cord length is the remaining
  fuse (`clamp(left / 3000, 0.25, 2)`, from the create's `lifetime`). The code-drawn cord is only
  for the `mob/mob` fallback. **A released Broodling is drawn over its Brood while it emerges**
  (#52 lane 5): `emergeReleased` stamps `Mob.emergeAbove { parent, until }` for
  `EMERGE_ABOVE_MS` (1500, equal to the server's `emergeMs`, held by `brood.spec.ts`), and
  `Mob.update` sets `zIndex` to `emergeDepth` (at least the parent's y + 1, until then or until the
  parent is killed or destroyed). The Brood, about 3 cells wide, still covers a ring-2 cell on its
  north side. It relies on the Brood updating before its Broodlings in a frame (`Game.MOBS` is
  push-only). A late viewer gets no pick, so no raise.
- **Loaded + launch** (Brood stream, Nick 2026-10-09; client only, no wire change). **Sockets:**
  the Brood's pose carries the package's three socket anchors (`NpcPose.sockets`, from
  `ART.body.sockets` via `bodySourcePoint` in `npcs/brood/rig.ts`), moving with the body in every
  clip; `NpcSprite.socketPoints` holds them in px as last drawn, jolt included, and `onPosed`
  runs after each drawn frame. `vfx/broodsockets.ts` `BroodSockets`, a child of the Brood's
  `NpcSprite` made in `Mob.initAnimation` only when the Broodling's sheet is loaded too, sits one
  real Broodling rig per socket, `NpcSprite.pin`ned at its `emerge` 1.3 s (curled; drawn once,
  no shadows, no ticker), at its own `sizeScale`. **The sockets are cosmetic**: all loaded at
  first, one empties at a launch and refills `SOCKET_REFILL_MS` (800) after it, growing from 0.4
  to 1 over 160 ms; all hidden once the Brood is dying. **Launch** (`vfx/broodlaunch.ts`,
  pixi-free, `broodlaunch.spec.ts`): effect 19 calls `emergeReleased`, which on a pick with a rig
  calls `Mob.launchFrom(brood)`; the socket is the loaded one pointing most nearly toward the
  landing cell (`pickSocket`; none loaded, the best of all). **The flying Broodling is the real
  unit** the server created on its cell: drawn in the socket from the effect (the cosmetic seat
  emptied), launched at `LAUNCH_MS` 180 (the Brood clip's `spawn` event), flying `FLIGHT_MS` 450
  on `kilnFlight` with an `ARC_PX` 36 arc, landing at 630 ms inside its 1500 ms emerge, its HP bar
  hidden in flight (`Mob.fly`, `NpcSprite.lift`). Never drawn on the ground before it lands, so
  never twice. The seat follows the Brood until the launch, then the path is fixed (a Brood dying
  mid-flight changes nothing). Killed or removed mid-flight: `dispose` calls `land()`, so its death
  plays on its own cell, where the server set it off (a beam aimed at it is drawn to the cell).
  `emergeReleased` returns whether it launched; **the pod is thrown only when it did not** (no rig
  or sheet, sockets not drawn yet, no pick for a late viewer; a viewer not holding the Brood gets no
  effect 19 at all). The socket choice
  uses the Brood's drawn position, about `interpolationDelay` behind (cosmetic). Cost: three
  pinned sprites per Brood, placed on each Brood frame drawn; not measured on a crowded screen.
- **Hit sparks spread by drawn width** (#52 lane 5): `hitSpark` places the spark at
  `sparkX(bodySpan, radius, u)`, over the middle `SPARK_SPAN` (70 %) of a rigged NPC's drawn width
  (`bodySpan`: the x extent of its idle pose's images, contact shadows and emission left out, in
  rig units, once per rig, scaled by `SCALE x sizeScale`), and the upper two thirds of its height.
  Robots and unrigged mobs keep the wire `radius`, which for NPCs is no longer the drawn size
  (server `body` was left as it was on purpose: nothing visible reads it on a rigged NPC). On the
  Brood's round top some sparks hang in the air beside the dome (a look call for Nick).
- `objects/mob.ts` uses `NpcSprite` when `lookFor` names an NPC rig whose sheet loaded (sheets
  load in the background from `Game`'s constructor), else `mob/mob`: old ids and unknown ids
  unchanged. HP bar 60 wide for epic and legendary (and the retired boss). Threat rings include
  NPC attacks (`attackReach`: a Kiln shows 8 rings); whether a lob should be marked by its reach
  is Dez's to propose after play. `game.ts` reads them through `ui/elements/threatmarker.ts`
  `threatRings(archetype)`, which passes the mirror's `attack` (l1-9).
- Unmeasured: client cost of many rigged NPCs in view (each poses, draws and, with shadows on,
  runs its own `AlphaFilter`; the Reactor's mask is a filter pass each; Kiln flames and Brood
  lamps are `Graphics` rebuilt every frame); check the FPS overlay on a crowded -1/-2 before
  release. Rig-side pose and draw, measured in node: Crawler 3.7, Coil 1.4, Kiln 6.8, Brood 17.6 µs
  a frame.
