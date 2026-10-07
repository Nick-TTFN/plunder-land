# Robots: stats, rigs and finishes

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Unit stats

**Unit stats live in one table**, `src/archetypes/archetypes.ts` (peep, magnet, grunt, boss, gunner).
**A robot's shown stats (HP, armor, speed, pickup reach, `damageScale`) are in the mirrored
`utils/archetypes.ts` `stats`** and its row takes them from there (`robot()`, robot-select #42), so
the lobby and the server read one table; `damageScale` multiplies every skill's damage through
`Skill.dealt` (`robotselect.spec.ts` fails on a hit that skips it), read through the `Unit.damageScale`
getter, which `Player` overrides to add gear (#49). A join picks the robot by
`start_requested.robot` (a key), only from `SELECTABLE_ROBOTS` and only one the account's level has opened (`unlockLevel` on the mirrored row: Peep 1, Magnet 3, Periscope 5, Hopper 8, Waddle 12; #48 step 5), else peep
(`lockedStart` in `progress/unlocks.ts`, from `Multiplayer.startRequested`; never in `World.robotFor`, so bots ignore locks). The rest of a row:
body, HP, speed, loot, contact damage with its cooldown and range in rings (`contact.rings`,
1 for every mob), kill-stat keys, skills with per-archetype overrides, and AI routines with
their parameters. `body` is the wire's `radius` and is drawing only: since hex-cells P1-P3
(#31) every gameplay rule reads cells, never a radius. There is no `Boss` class.
`src/archetypes/baseline.spec.ts` pins the pre-refactor behaviour; change it only on
purpose. `plunder-land-client/tools/archetype-bot.mjs <server-url>` records what a real
join sees on the wire (Node 22.18+).

## Rigs

_NPCs (#51) have their own rig framework, `NpcRig`/`NpcSprite` in `src/npcs/`, a sibling of
`RobotRig`/`RobotSprite` that shares only pure helpers: see `docs/npcs.md` ("Client: rigs and
sprites"). Nothing below changed for it._

**Peep (every player robot) is a skeletal rig, not a frame sheet** (2026-09-30; v16 since
2026-10-01, from the drops in `plunder-land-client/codex_output/`, not checked in; it is a custom JS rig, **not
Spine**). `src/peep/rig.ts` is a hand port of the drop's `rig.mjs` + `legacy-motion.mjs` (pose in,
bone matrices out, pixi-free), under the eye shot below. `robotrigs.spec.ts` (server) checks every
robot's port against poses sampled from its drop's own modules: the bones, every image's drawn
corners and every stroke and fill (the eye shot's rings and dot, Hopper's coil). A new drop: re-run
`tools/peep-rig-sync.mjs <robot> [drop]` (hulls + fixtures), fix the port until the spec passes, and
`tools/bake-peep-atlas.py <robot> [drop]` (`peep.png`, 13 KB, and `--lobby`).

**Every robot shoots from its eye** (the eye-firing drops, 2026-10-01: Peep v16, Magnet v3,
Periscope v3, Hopper v2, Waddle v2; no robot has a gun any more). The drops share one
`animations.mjs`, ported once as `src/robots/eyeshot.ts`: the body's clips with the guns taken out,
and the shot laid over them. The shot is an eye state 0.8 s long (`SHOT`): two rings close in on the
eye's focus, a bright dot fires at **0.36 s** (`SHOT.fire`), the normal eye is back by 0.68 s
(`chargedEyeMarks`, drawn by `RobotSprite.drawShot` with a flat stand-in for the drop's Canvas glow).
The `shoot` clip is the reference pose plus a small recoil after the fire; while running,
`RobotSprite` lays the eye shot over the run instead (`eyeShootTime`). Aim no longer moves an arm:
the body is posed at aim 0 and the aim turns the head and eye; `eye_muzzle` (and its alias
`muzzle`) is the shot's origin, `RobotSprite.aimPx` its height, which `Player.aimToward` and the
lobby measure aim from. **The server still deals ranged damage on the press**; the client holds the
beam `SHOT.fire` after the effect arrives for a rigged shooter (Nick, 2026-10-01: "hold the beam",
over playing the charge without it or a server-side windup), so a hit can show before its beam
(`RangedAttackEffect`). The beam's bright line leaves the eye (`Unit.eyeGlobal`, the rig's `eye_muzzle`
mapped through pixi) and runs at that height to above the target; its dark shadow line and the lit
cells stay on the ground, so the two don't line up exactly (Nick, 2026-10-01: "let's try"). The rig never reads an image's size, so
the bake resamples each part to its box in rig units at `RobotSprite.PEEP_HEIGHT` (53 CSS px since 2026-10-01, Nick: "all chars ~20% bigger in game"; Peep
itself is drawn at `drawScale` 0.9 of it, 48 px, "relatively cute"; 44 before, Nick:
a third of the 128 first tried) x 2; change the height in both. `RobotSprite` places 13 regions a frame (about 33 sprites with finish layers); no visor or lens mask (Nick's
call). Clips: idle/run by movement (run at `RUN_RATE` 2x the drop's speed, Nick 2026-09-30, scaled
by ground speed over `STRIDE_SPEED` 140, clamped 0.5-3x, so a dash runs the legs 2.5x faster again;
`Player.applyPosition` measures it, for remote players too; backwards while moving against the
way it faces, e.g. aiming behind, except during a dash, which faces and runs the way it goes: `Game` drops
your mouse aim while `LocalPlayer.dashLeft` > 0, Nick 2026-10-01; per robot, `RobotRig.runRate` (Waddle 1.5,
its 0.9 s stride was too slow) and `RobotRig.loops` (Hopper's idle and run are both its jump clip
as a bounce: only the landing squash, the push-off and the flight, 1.0-1.07 then 0.17-1.0 s, about
0.15 s on the ground a 0.9 s loop, Nick: "he should just bounce"; a dash doesn't speed it up, `RobotRig.maxPace` 1; so it bounces everywhere and a shot is the eye's alone, laid over the hop; Nick 2026-10-01)), swing on melee (press and effect, deduped by
`RETRIGGER_S`), shoot on the ranged effect turned and aimed at the shot's end (the eye shot), hit on an hp or armor drop, fall_apart on death (removal after 3 s).
The eye smiles for `Player.LOOT_SMILE_S` (0.5 s, Nick) on a loot gain (not the first loot seen for a
robot coming into view); as in the drop's preview, a change of expression is a blink with the eye
swapped 0.06 s in, and auto-blink pauses while smiling (`RobotSprite.smile`).
Jump is unused (Nick). **Cast shadows fall to the bottom right** (Nick, 2026-10-01; they leaned up-left), all through `objects/shadow.ts` (`layShadow`): mobs, StoneWall stones, loot and items (silhouettes since 2026-10-02; they were contact ellipses), and in game the rigged robots, whose shadow is every part again in black under one `AlphaFilter` (`RobotSprite.cast`, a render pass per robot on screen; not in the lobby). The drop's contact ellipse stays under the feet. What is drawn as an offset instead of a laid silhouette leans the same way through `shadowOffset(height)`: walls, and portal and exit pads (a black copy `PAD_HEIGHT` 6 px down-right under them, Claude's pick). Your own robot's head and eye follow the mouse (`Player.aimAt` from
`Aim.world`): facing flips to the mouse's side, the rig clamps aim to +-60, so straight up and
down are accepted dead zones; no mouse over the world gives facing back to movement. Other
players aim only in actions: aim isn't on the wire.

**Magnet is drawn by its own rig** (magnet-rig, #42, v3 since 2026-10-01):
`src/magnet/rig.ts` ports the drop's `rig.mjs` + `legacy-motion.mjs` (the magnet on the far arm,
swing with the magnet, a heavier magnet in fall_apart; the gun on the near arm went in v3, and with
the body posed at aim 0 the magnet no longer follows the aim unless given its own `magnetAngle`).
One sprite class draws both: `src/robots/robotsprite.ts` (`RobotSprite`, was `PeepSprite`) over a
`RobotRig` (`src/robots/robotrig.ts`: sheet, regions, clips, pose, eye matrix and size, the eye
shot's radius and offset, reference height, shadow sizes). Every robot is drawn at Peep's pixels per rig unit, so Magnet (227.9 units)
stands about 49 px to Peep's 48 (Peep is drawn at 0.9). Its sheet is `magnet.json` (`tools/bake-peep-atlas.py magnet`,
15 KB). **The lobby draws robots from 2.75x sheets** (`peep-lobby.json` 45 KB, `magnet-lobby.json`
58 KB; `bake-peep-atlas.py <robot> --lobby`; `RobotSprite(host, rig, lobby)`; `LOBBY_DENSITY` is 2.75 x 44/53
since robots grew in game, which kept the lobby sheets byte-identical), because it shows them up
to 5.5x the in-game size and the game sheet was visibly soft there (Nick, 2026-10-01: 2.75x, not
5.5x at ~260 KB). The game sheets stay texel for pixel. (The v15 shoot/swing clearance revision that
the Peep port once lacked came in with v16; its neck part is inert there, as in the drop, because
the eye shot sets Peep's neck from the look.)

**Periscope is drawn by its own rig** (#43, v3 since 2026-10-01):
`src/periscope/rig.ts` (every robot's fixtures also sample each clip at twelfths: the fixed times
missed a changed swing key). A sensor head on a two-section neck, a swing of chassis weight and
sensor follow-through (its side-mounted gun went in v3), and an eye in the sensor's own space, so
`RobotRig` carries each robot's `eyeMatrix` and `eyeSize`. Its neck is painted with the head group (the drop's mask). Sheets:
`periscope.json` 11 KB, `periscope-lobby.json` 45 KB. **Periscope is drawn 1.35x Peep's pixels
per rig unit** (Nick, 2026-10-01: "30-40% bigger, he's slim but tall"): `RobotRig.drawScale`, and
the bake's `DRAW_SCALE` bakes its sheets 1.35x denser to match; change both together. In the
lobby a robot is also capped to the room between the name pill and its feet, so the tall one
shrinks to fit on a short screen.

**Hopper and Waddle are playable** (2026-10-01, Hopper v2, Waddle v2; Nick: "unlock the other 2"): `src/hopper/rig.ts`
(a head on a spring on one boot; the spring is stroked by the client, `SPRING_STROKES` /
`springPoints`, not baked) and `src/waddle/rig.ts` (a shell with two eyes; the shot fires from
between them, `RobotRig.shot.offset`); sheets `hopper.json` 7 KB, `waddle.json` 15 KB, and lobby
sheets. Stats are #16's table with #43's vision: Hopper HP 90 / armor 50 / 140 / pickup 1 / vision 6,
Waddle HP 130 / armor 100 / 120 / pickup 1 / vision 6. Hopper's trait (#15) is
built since walls (#44): it passes walls and stones, see "Walls inside the islands". Their `referenceUnits` are the top of the reference pose's boxes (193.9,
190), not measured from the art's alpha like the others. Hopper's head and Waddle's shell are
painted in two groups (body and head): the bake gives such a part a shade and patterns per group
(`<group>-shade`, `meta.finish` group `mixed`) and `RobotSprite` tints each stack by its own group.
Hopper's bake self-check is the loosest (arctic interior p99 22.9 of the 24 limit), then Periscope's
(about 20).

**Finishes: each robot's head, body and limbs are painted separately** (robot-finishes,
decision #41, 2026-09-30), from the drop's material maps (`materials/`: neutral, masks,
lighting, pattern-data). Every painted part is one paint group; the bake asserts it. Such a part
is four kinds of layer in `peep.json` (`peep/<art>/shade|zebra|checker|camo|fixed|hi.png`, listed
in `meta.finish`): the shading tinted by the group's colour, the group's pattern at its opacity,
the unpainted details, and the highlights with `BLEND_MODES.ADD` (drawn normally they came out
up to 60/255 too dark; the cost is two batch breaks per part with highlights, six parts, so
roughly a dozen more draw calls per robot on screen: derived, not measured).
`RobotSprite.setFinish` applies one. The bake **checks itself** against the drop's
`compose.mjs`: interior p99 at most 17/255 (the drop clamps to white per pixel, which a
colour-free layer can't copy) and it fails above 24. Light above 1x (up to 1.36 on the torso)
is dropped, because a tint can't brighten; Nick accepted it. The colours and patterns are
`utils/finishes.ts`, mirrored like `items.ts`: the ten colours of the drop's six presets
(Claude's pick, Nick may change it), patterns none/zebra/checker/camo with the opacity fixed per
pattern (camo 0.45), and ids append-only. Each colour and pattern has an `unlockLevel` (#48 step 5, Dez v1): MINT, CREAM and SAND and PLAIN and ZEBRA at 1, OLIVE 2, CAMO 3, ICE 4, SKY 5, PEACH 6, CORAL and CHECKER 7, VIOLET 9, BONE 10; the presets open at MINT 1, FIELD and WILD 3, ARCTIC 5, SUNSET 7, ARCADE 10. A join wears `lockFinish` of what it asked for: per group, a locked colour or pattern becomes that group's `DEFAULT_FINISH` part. `finishFromBytes` never locks, because it also decodes other players' finishes. They are picked in the lobby.
