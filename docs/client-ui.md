# Client UI: settings, lobby, fog, HUD, input

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Settings

**Settings** (L3 without sound, 2026-10-04): `net/settings.ts` (pixi-free, localStorage
`plunderland_settings`, every field falls back alone, a clash falls back to the default keys) and
`ui/settings/settingspanel.ts` (DOM, `st-` classes), from the lobby's SETTINGS and Escape in game;
while open it takes every key (the lobby's handler steps aside). Skill keys (Q W E R) and item keys
(1-5) rebind, single characters only, Enter/Space/Escape reserved, a key in use swaps; mid-run the
cards rekey with cooldowns kept (`HUD.rekey`). Resolution auto/1x/2x (`densityFor`) applies at once;
ROBOT SHADOWS (`RobotSprite`'s cast pass) from the next run. SOUND is a greyed row until there are
sounds. The old S key toggled an unused `Game.simulate`: removed.

## Lobby

**The lobby replaced the enter popup** (lobby-rework, #42; mockup in the project memory,
`ideas/lobby-mockup-2026-09-30.png`). `ui/lobby/lobby.ts`: pixi draws the backdrop, the platform
and the robots (the chosen one large, aiming at the pointer, the next one dimmed); DOM over the
canvas (`lobbystyle.ts`, all `lb-` classes, placeholder chrome) carries the name pill, robot cards
(stills rendered from the rigs; pickable from their unlock level since 2026-10-01, `ui/lobby/roster.ts`,
whose class lines and taglines other than Peep's are placeholder copy), stat bars read from the
mirrored `stats`, CUSTOMIZE (head/body/limbs rows of the presets' swatches, or MIX for any colour
and pattern) and READY UP. Keys: left/right, E, Enter. It remembers robot, finish and name
(`plunderland_player_robot`, `_finish`, `_name`). Robots, preset swatches and MIX colours and patterns the level hasn't opened are disabled with an `LV n` badge (`ui/lobby/locks.ts`, pixi-free, run by `unlocks.spec.ts`; level `ACCOUNT.info?.standing?.level ?? 1`). The stored robot and finish are the wish: shown and sent as the level allows, and the robot is stored only when picked in this lobby, so a fallback (an outage, the account not yet announced, an arrow with nowhere to step) never overwrites it. A level arriving while the lobby is open re-renders it. Not done: the hangar background (art), the
COLLECTION tab, the title (PLUNDERLAND here; the mockup says SCAVENGERS). `assets/index.html`
now declares `<meta charset="utf-8">`: without it a server that sends no charset decoded the
bundle as Windows-1252 and every non-ASCII string (the lobby's arrows) came out as mojibake.

**The lobby's STASH panel** (#49, 49-4/49-5; `ui/lobby/stashpanel.ts`, DOM, `lb-st-` classes,
placeholder chrome; logic in the pixi-free `net/stash.ts`, run by `gear/stashclient.spec.ts` and
`stasheditclient.spec.ts`). Button beside LOADOUT, key S; one of the three panels open at a time. A
12-cell grid (`STASH_SOFT`) with the overflow under it, and from 12 items a warning that extraction
still keeps everything; the focused item's card uses the HUD's own words (`itemLines`). The loadout's
Q W E R sit read-only beside the two bring keys 3 and 4, locked with `LV 3` below `BRING_LEVEL`; a
part can't be brought, and a duplicate of a kit skill says IN KIT. The picks are remembered per
account id in localStorage `plunderland_bring` and sent as `start_requested.bring`. **A brought id
stays remembered while its row is away** (out of `items` during the run that carries it, back under
the same id on extraction), so it is dropped only from what is shown and sent (`shownBring`), not
from memory. MERGE picks 3 (other tiers dimmed but tappable, so the reason line can say why), a
keep chip when skill items are among them, then MERGE 3; the result card (OK, MERGE MORE) is where
the Q11 reroll would go if Nick ever says yes. SCRAP sits on every card behind a confirm. **The
client copies no merge odds**: its preview says "by chance", so `PART_MERGE_SKILL_CHANCE` has one
copy, on the server. No answer within `STASH_EDIT_WAIT_MS` (8 s) frees the buttons. Another tab's
edits show only at that tab's next `stash`.

## Fog, markers and the run card

**Fog of war is enforced by the server since #48** (shipped 2026-10-03; drawn by
`src/objects/fog.ts`, decision #36). Cells within the robot's `vision` rings (the mirrored
`utils/archetypes.ts`: 6 for every robot but Periscope, 10 for Periscope (Nick, 2026-10-03, for the tick; 11 from #43), 8 before;
null = no fog) are visible, cells seen before on that layer this run are explored, the rest
unknown. The server sends units, pickups, projectiles and StoneWall stones only within
`vision` + 1 rings and keeps them to + 2 (see "Who gets what"), so the client's fog draws what
arrives and a modified client sees at most 2 rings past it. The 500-unit box no longer caps
vision: the interest buckets grow with the largest one (`World.INTEREST_BUCKET`), so Periscope
could have the 12 rings first asked for in #43 (not decided). **While spectating, the fog's
radius is the watched robot's vision** (`Fog.setRadius`, set each frame in `Game.update`, since
the `spectate` event can arrive before the watched unit's create; the next run's `Fog.reset`
restores it), because that is what the server sends. The ground is tinted per
cell (`HexTerrain.tintOf` / `retint`); `Game.applyFog` sets every object's **`renderable`**
each frame: units, pickups and projectiles only on visible cells, terrain on visible and
explored, portals, exits and your own robot always (#16). `renderable`, not `visible`, because
other code already drives `visible` (a unit that left view, a stale one) and the two
would undo each other. The minimap draws only `renderable` objects, or it would show what fog hides.

**World markers** (`world-markers`, M2, placeholder look). Every unit has a fixed-width
health bar over its head (`ui/elements/unitbar.ts`: 36 px, 60 for a boss; red); it used to be
`maxHp` pixels wide. **A player's is a panel over its head** (`ui/elements/unitpanel.ts`, Nick,
2026-10-01): name (YOU for yours, in the accent colour), then a green hp bar and a blue armor bar,
40 px, for every player (armor reaches every holder; `Unit.onArmor`). Before, the name plate sat
under the feet with a blue (green for you) bar over the head. Portal "LAYER 0N" and exit
"EXTRACT" labels are plates from `ui/elements/nameplate.ts`, under the thing they name. Red
**threat cells** (`ThreatMarker`) are the union of a disc per boss (FireBreath's 4 rings: it
can turn to any side) and gunner (its 6-cell shot) the player can see; grunts are left out.
The reach is `threatRingsOf` in the pixi-free `vfx/cells.ts`, pinned to the server's skills
by `effectcells.spec.ts`. The route is cyan and ends in a lit hex. Shapes and colours read
in a 720p frame shrunk to 240p; plate text does not.

**A run ends in a card** (`ui/popups/runsummary.ts`, `run-summary-card`): outcome, time, loot
banked or lost, kills (`kills`, 21), deepest layer and robot, from `Game.RUN`. Its PLAY
AGAIN (or Enter / Space) calls `Game.start`; there is no longer a 2 s automatic restart. A
level-up's XP line is followed by what it opened (`unlockedBetween` in `ui/lobby/locks.ts`, from the
same mirrored rows as the locks; the level before comes from the lobby's last standing).
Its GEAR row (`gearLine` in `net/stash.ts`): a death, or any offline end, is GEAR LOST and the
count from the player's last `carried`; an extraction carrying nothing is GEAR KEPT 0 at once (the
server sends no settle then); otherwise `...` until the `stash` with `run` (which can land before or
after the destroy; `RunRecord.stashRun`, reset in `start`), then GEAR KEPT `run.kept`, or STASH FULL
when `run.full` > 0, and UNAVAILABLE after `PROGRESS_WAIT_MS`.

**The canvas renders at the screen's density** (`index.ts`: `resolution` = devicePixelRatio
capped at 2, `autoDensity`, re-read on resize). pixi's default of 1 gave a Retina screen a
half-resolution canvas stretched 2x, and everything looked soft. Layout, pointer coordinates
and `renderer.screen` stay in CSS pixels. Headless screenshots need `deviceScaleFactor: 2` to
see the difference.

An invisible plane sets `layer.visible = false` rather than sitting at alpha 0 — `visible` is
the only flag that skips PIXI's transform pass as well as the draw, and there are now about a
thousand pads behind it.

## Input: the stage has to be its own hit target

**`app.stage.hitArea` must cover the canvas** (set in `onResize`), or click-to-move works only
where something happens to be drawn. pixi dispatches a pointer event to the innermost thing
under the pointer and bubbles up from there; with no hit at all there is no event and the
stage's listener never runs. That was free while the ground was one `TilingSprite` over the
whole map — every click landed on a sprite. Hex pads are `eventMode: 'none'`, so clicks on bare
ground stopped reaching anything and routing worked only when a mob, a rock or a pickup was
under the pointer. It reads as "click-to-move is flaky", which is a long way from its cause.

The other half of the same rule: **`onPointerDown` ignores anything whose target is not the
stage.** Events bubble, so a press on a skill button reached the world handler too and walked
the player in under the HUD. With the hitArea in place, "target is the stage" means exactly
"nothing interactive was hit", which is the world.

Movement is click-to-move only. The on-screen joystick is gone — it was a second way to say the
same thing, it aimed at a cell five out rather than at a destination, and its
`pointerDown` flag was a hidden gate on the world's own click handler.

**A HUD button takes the press on its container, not its background** (`SkillCard`, inventory
slots): pixi hit-tests every child, so a press on the icon or label hit that child and bubbled past
a listener on the background sibling. Until 2026-10-04 only a card's empty edges cast.

**Touch** (L9 part, 2026-10-04). `assets/index.html` has a viewport meta (without it a phone laid
the page out 980 px wide, zoomed out) and `touch-action: none` on the canvas. A tap moves, as a
click does. **Aiming on touch** (`skills/touchaim.ts`, Claude's design): a tap on an aimed skill's
card (`Skill.aims`: ranged, fireball, icicle, ice breath) arms it (TAP TARGET, a ring); the next
world tap casts at that cell instead of moving; the card again casts along facing; it disarms after
4 s. Other skills cast on the tap. Items (the bomb too) use along facing. **Phone HUD**
(`HUD.phone()`, either side under 520 px): the leaderboard opens and closes from the clock, the fog
legend isn't drawn. **Lobby under 500 px tall** (a phone held sideways): three columns, no cards row
(the arrows switch robots); under 720 px wide PRIVACY sits under READY.

**Ranged charges on the press** (2026-10-04): your own robot's eye shot starts on the key press
(`RangedAttackEffect.pressed`), the server's effect no longer restarts it (the shot overlay dedupes
like actions, `RETRIGGER_S`), and the beam waits only for what is left of `SHOT.fire` since the press.
Defend stays on arrival: its protection starts at the server.

`GameObject.DEBUG_COLLIDERS` is off. It draws a magenta disc the size of the collider under
every object; the `// return` that used to switch it off had been commented out, so the
shipping game had one under everything.
