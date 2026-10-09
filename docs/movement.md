# Grid, routing and movement

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## The grid, and how it is drawn

`Hex.SIZE` is **45 world units, the distance between neighbouring cell centres** (not
centre to corner: a corner is 26 from the centre, the inradius `Hex.RADIUS` 22.5, and one
ring is 39–45 units depending on direction). `utils/hex.ts`, `utils/path.ts`, `utils/archetypes.ts`,
`utils/items.ts`, `utils/finishes.ts`, `utils/protocol.ts`, `utils/skills.ts` and `utils/gear.ts`
are byte-identical in both packages (`mirror.spec.ts` enforces it). It was 35, picked so 140 u/s covered one cell
per 250 ms tick; that coincidence lost to legibility — the player sprite is 50 px and the
game draws at 1:1, so a 35-unit cell was smaller than the character standing on it. Movement
is continuous along the path, so nothing depended on it and no speed changed.

Anything that moves with `Hex.SIZE` should be **derived from it, not written down**:
`Path.WINDOW` (140, the longest hex distance across a 4000-unit map), the path marker's
radii, the eastern-edge cell in `world.spec.ts`. Three separate literals went stale the one
time the cell size moved.

**Entering the last cell of a route is not arriving at it.** `followPath` (server `unit.ts`,
client `localplayer.ts`) only ever re-aims the index (after push-out's shoves until hex-cells P2; now only when a
tick carries a unit past a cell); it caps the index at
the last cell and never ends a route. `walkPath` / `_step` is the only thing that does, and it
finishes exactly on the centre. The two were in the wrong order once and a walk came to rest
about half a cell short of the middle, every time — invisible while a cell was 35 units and a
tick's travel was also 35, because the two crossings then fell in the same tick.

**Arriving does not clear the waypoints, only the path.** The client walks in real time and the
server starts a tick later, so the client always finishes first; clearing the waypoints on
arrival made the next input packet a "stop" that landed on a server still short of the
destination. `LocalPlayer._arrive` keeps the destination, so arriving is no change and sends
nothing (clients before server-cpu-trim repeated it every tick, which `sameCells` made free).
`stop()` stays for a real stop.

**A layer change ends the route, on both sides** (`Unit.changeLayer`, `LocalPlayer.changeLayer`):
set the tag, then `stop()`. The client doesn't predict the hop: it walks to the portal's
centre and waits there. When the tag arrives, a tick or so late, `LocalPlayer.changeLayer`
jumps with no easing to the position that came in the same record (`Game.onObjectUpdated`
reconciles a record's position before its tag, and `reconcile` remembers it), then stops.
The arrival is one cell away, inside the reconcile dead zone, so without the jump it would
be ignored. The client's route doesn't change while it waits, so it sends nothing meanwhile
(an older client repeats the old route, which `sameCells` in `Multiplayer.onPointer` ignores). `extract.spec.ts`'s mirror harness covers it with
the tag 1-3 ticks late. Known gap: a new click in that window is planned on the old layer and
shows as a correction.

`HexTerrain` (`src/objects/hexterrain.ts`) draws the ground as one sprite per cell, pooled,
rebuilt only when the camera's own cell changes. Two things about it are load-bearing:

- **A cell's face is derived from the cell, never drawn at random**, or the ground boils as
  you walk and every re-entry into view reshuffles it.
- **A value-noise field picks the *palette*, and a hash of the cell picks a face within it.**
  Choosing per cell out of one palette was the first build and it looked like static —
  patches are what makes it read as ground. `meta.regions` in `hex.json` fixes the order the
  palettes lie along the field; value noise is centre-heavy, so the middle ones dominate.

## Movement: three different mechanisms, deliberately

Do not collapse these into one. They were one before, and that is what made the game feel
like it did.

1. **The local player is predicted.** `Game.LOCAL` (`src/net/localplayer.ts`) applies input
   immediately and reconciles against the server. It is the one object in the scene that is
   never fed through `onObjectUpdated` — `Game.PLAYER`'s position comes from
   `Game.LOCAL.renderX/renderY` in `Game.update`. `LocalPlayer._step` mirrors the server's
   `Unit.walkPath`, including Dash (`routeBudget` / `_routeBudget`), the route cut at portals
   (`endAtPortal` / `_endAtPortal`) and the facing set for each segment walked; **if one
   changes, the other has to change with it** or prediction starts fighting the authority.
   There is no push-out on either side (hex-cells P2): terrain blocks cells, units don't, and
   routes only cross free cells.
2. **Remote units are interpolated**, not chased. `Unit.pushState` records authoritative
   states and `Unit.update` renders at `now - Session.interpolationDelay`, interpolating
   between the two states straddling that time, extrapolating for a bounded window on
   underrun, then holding.
3. **Animation follows intent, not rendered movement.** `Unit.applyPosition` takes an optional
   motion hint; the local player passes `LocalPlayer.moveX/moveY`, which is the predicted step
   with no correction in it. Driving the run cycle and the sprite flip from the rendered delta
   made the player jog on the spot and flip to face the wrong way every time the server nudged
   them, because the render position carries the decaying correction offset. Remote units have no
   intent to read and correctly fall back to the rendered delta.
4. **Corrections are eased, not snapped.** `LocalPlayer` keeps a decaying render offset so a
   small disagreement is walked off over ~100 ms; a disagreement over 220 units is treated as
   a teleport and shown immediately.

**Mobs step cell to cell** (`Unit.step`, hex-cells P2, #31). The AI sets `stepGoal` (a cell
and how near to get) every tick; at each cell centre the mob takes the neighbour nearest the
goal that `World.mobCanEnter` allows (not blocked, not a gate or arrival cell, not held),
ties to the lowest `Hex.DIRECTIONS` index, and stays if none is nearer (`Unit.chooseStep`,
greedy: a single rock on the hex axis stops it dead; BFS is the documented upgrade in a
comment there). A step once started is always finished. **One mob per cell**: a mob holds
the cell it left and the one it enters until it arrives (`World.STEPS`), and its own cell at
rest (`World.mobHolds`, through the `UNITS` index). Players may share cells with each other
and with mobs. Contact damage lands within the archetype's `contact.rings` (1: adjacent or
the same cell, `Mob.touch`), and the chase stops there (`GuardPosition.chaseStop`, or at the
standoff if that is further: the gunner's 5). **`stepGoal.away`** (#51, l1-4) is the same greedy
choice reversed: the furthest enterable neighbour from the goal, ties to the lowest index, staying
put (and setting `stepBlocked`) if none is further; it is server-only (`LocalPlayer` mirrors
`walkPath`, not `chooseStep`). `GuardSpec.retreat { min, max }` uses it: below `min` rings the mob
backs away, within the band it holds, beyond `max` it closes to `max` (Kiln and Brood, 5-6). No
leash: a player can push a retreating mob any distance from home while within `lose`. A mob
that plants or winds up an attack (Reactor, Coil, Compactor, a primed Broodling) clears
`stepGoal` every tick after its guard; the step in progress still finishes.

**Knockback** (#51, l1-6; the Compactor's slam, `docs/npcs.md`) is the one move the server makes
to a player that the player didn't ask for, and it is **mirrored**: `Player.knockback` (server)
against `LocalPlayer.knockback` (client), held by `extract.spec.ts`. Server: after the landing
walk, `stop()`, then `connection.lastWaypoints = []`, unlike `changeLayer`, which keeps it: the
client sends a route only on a change, so the knocked route must be sendable again or a re-click
of the same cell is dropped as a repeat (`sameCells`) and the player is rubber-banded. Then the
landing centre through the setter, and effect 15 to the victim's holders, its own connection
included. Client: `Game` parks effect 15 for `Game.PLAYER` and applies it in `onObjectsUpdated`
**right after the same flush's header `lastInputSeq` is read** (effects precede the update in
every frame, `frame.spec.ts`). `LocalPlayer.knockback(cell, ackedSeq)` jumps to the cell's centre,
eased like a correction but never ignored by the dead zone, then: if `ackedSeq` is the seq of our
last sent route and that route is still ours, the server stopped it, so `stop()` and clear
`_sentRoute`; otherwise it re-plans our newer or not-yet-sent route from the landing cell, as the
server will. A plain "jump then stop" desyncs a click made in the window. `Game._knockback` is cleared
on every `Game.start`, beside `resetForRun`.

**A slow reaches the client through `speed` (27) a tick late** (#51, l1-3, the Coil's `FieldSlow`).
No new wire: the own player's `maxVelocity` goes out on change. The drift a tick is the speed
change x 0.25 s: 14 units at the Coil's x0.6 and 17.5 at the Icicle's x0.5, both inside the dead
zone (0.25 s x speed x `LEAD_TICKS` 2), so no correction. Stacked (x0.3, 42 u/s) it is 24.5
against a 21-unit dead zone, so **only the stacked case** gets eased corrections (1-4 in the
mirror specs, never a snap, same end cell). If Nick feels a hitch under both slows, the fix
belongs in `reconcile`, not in a new field.

`Session` (`src/net/session.ts`) owns every timing constant, and separates what the server
*says* (`tickMs`, from `hello`) from what the connection *delivers* (`arrivalP95`, measured).
Interpolation is timed off the measured value.

**Liveness is not a heartbeat.** Idle units now send nothing at all, so "hasn't updated
recently" no longer means "gone". `Game.stillPresent` treats a silent unit as present if it
is inside the server's leave radius for the viewpoint's robot (your own, else the one you
spectate) plus 3 rings (`net/presence.ts`, 2026-10-03; it was the 500-unit interest box, which
hid every silent unit while spectating and cut into Periscope's view), and hides it when there
is no viewpoint (the cases where the server forgets without a destroy). The old per-player 3-byte id heartbeat
is gone; the update header replaced it with a fixed per-connection cost instead of a
per-visible-player one (break-even at about three visible players). Since #35 a unit that
leaves a client's view is destroyed (a destroy without `hp`, which the client hides at once),
so `stillPresent` only matters for a held unit idling in the exit margin.
