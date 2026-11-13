# Client UI: settings, lobby, fog, HUD, input

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Settings

**Settings** (L3 without sound, 2026-10-04): `net/settings.ts` (pixi-free, localStorage
`plunderland_settings`, every field falls back alone, a clash falls back to the default keys) and
`ui/settings/settingspanel.ts` (DOM, `st-` classes), from the lobby's SETTINGS and Escape in game;
while open it takes every key (the lobby's handler steps aside). Skill keys (Q W E R) and item keys
(1-5) rebind, single characters only, Enter/Space/Escape reserved, a key in use swaps; mid-run the
cards rekey with cooldowns kept (`HUD.rekey`). Resolution auto/1x/2x (`densityFor`) applies at once;
ROBOT SHADOWS (`RobotSprite`'s cast pass) from the next run. VOLUME (OFF/LOW/MID/HIGH) is the
sound module's own setting, not a `Settings` field (see Sound). The old S key toggled an unused
`Game.simulate`: removed.

## Portals (itch, CrazyGames)

`net/portal.ts` (#56): `PORTAL` (`config.ts`) is `itch` inside itch's embed (`*.itch.zone`,
`*.itch.io`) and `crazygames` on `crazygames.com` and its subdomains (#62, g2-2: their file host
`<slug>.game-files.crazygames.com`, and `games.crazygames.com`, the frame their iOS app runs; the
host of their QA preview is unchecked). `?portal=` overrides it. On both the lobby hides INVITE (a
link is built from the page's own address, which there is the bare game on the portal's file host;
CrazyGames' own invite links are an SDK feature) and Privacy links to our own site (`SITE_URL`).
Every asset path is relative (`res/...`), because itch serves the build from a subfolder; the Worker
serves the game only at `/`, so that is safe there. `SITE_URL` changes with a custom domain.

Page hygiene for an iframe (CrazyGames' requirements and common fixes, g2-2; `assets/index.html`):
no text selection on `body` (inputs stay editable), no context menu on the canvas (`index.ts`), and
arrow keys, Space, PageUp/PageDown and the wheel over the canvas don't scroll the host page (keys
pass through on a focused input, button or link; the wheel elsewhere still scrolls the lobby's
panels). The key guard is a capture-phase listener registered before any other: the lobby and the
settings panel capture keys and `stopImmediatePropagation`, so a bubble-phase guard never ran there.
Escape still opens settings in a run (CrazyGames only recommends avoiding it).

**Fullscreen** (g2-1, #62): a button in the lobby header (in the header menu under 760 px, as
Settings) and beside the settings cog in a run, on every device, whatever the input mode, wherever
`fullscreenButtonShown(PORTAL, fullscreenSupported())` holds: not on CrazyGames (their gameplay
rules prohibit a custom fullscreen button; their page has its own), and not where the browser has no
Fullscreen API for a page, which is iPhone Safari (no special case: `fullscreenSupported()` is false
there). Inside an iframe it also needs the host's `allowfullscreen`. Both buttons redraw on every
`fullscreenchange` (Esc included): corners out to enter, in to leave.

**Portal SDK** (g2-6a, #62: "go full in with adapter"): `src/portal/`. `adapter.ts` is the one
interface (`PortalSdk`: `ready`, `loadingStop`, `gameplayStart`, `gameplayStop`, `onMute`; the user,
link, rewarded-ad members are declared and answer null/false/`'unavailable'` until g2-6b..d);
`withGameplayState` passes on `loadingStop` once and `gameplayStart`/`gameplayStop` only on a
change. `none.ts` is the no-op (our site, itch, anything else); `crazygames.ts` adds CrazyGames'
SDK v3 script at run time, only on `crazygames`, awaits `init()` for at most 5 s
(`INIT_TIMEOUT_MS`), and uses it only in the `crazygames` or `local` environment (`disabled`, our own
site with `?portal=crazygames`, throws on every call); every call goes through one guard (never
throws, warns once per method), and calls made before init are replayed in order. `pick.ts` chooses
from the portal; `index.ts` holds `PORTAL_SDK`. Wiring: `loadingStart` as soon as init resolves,
`loadingStop` when the lobby is up (`index.ts` `onConnect`), `gameplayStart` on a run's `hello` (a
handoff's second `hello` sends nothing), `gameplayStop` at the own destroy (run card) and in
`Game.start` (the lobby, a reconnect); none on a hidden tab (CrazyGames: the platform handles it).
In the `local` environment (localhost) each call is logged as `portal sdk: <name>`.
`portaladapter.spec.ts` drives it with fake SDKs. Unverified: whether CrazyGames' QA accepts the
runtime script tag instead of the static `<head>` one their docs show.

## Sound

The minimal sound pass before the itch soft launch (#56). Effects only, no music.

- **`audio/sfx.ts`**: Web Audio, no library. `BANK` maps each slot name to its files in
  `assets/res/sfx/` (Nick's picks from Kenney's CC0 packs, `LICENSE.txt` there), a gain, an
  optional minimum gap and a pitch variety; a slot with several files never repeats the last one.
  Swapping a sound is a `BANK` edit. Files ship as Ogg Vorbis and MP3; the browser fetches one.
  Paths are relative (`./res/sfx/`).
- **Starts on the first pointer or key press** (browsers' autoplay rule): the context is made and
  the files load then; a play before that is dropped, not queued. A hidden tab suspends it.
- **Volume**: localStorage `plunderland_sound`, 0-3, default MID (2). Kept out of `Settings` so the
  settings shape and its spec stay as they are.
- **A portal's mute outranks it** (CrazyGames' `muteAudio`, g2-6a): `Sfx.setPortalMuted` silences
  the master (`masterGain`) and restores the level after, without writing `plunderland_sound`; a
  level picked while muted waits for the unmute.
- **Placed by distance only**: full within 200 world px of the listener (your robot, or the one you
  spectate), silent from 800, no panning. An effect whose unit or cell is unknown is not played.
- **`audio/gamesfx.ts`** holds the game logic, called from `Game` with plain values: effect types
  to sounds, wind-ups cut at their impact (Compactor, Reactor), the Kiln thruster from its launch,
  the extraction loop with a tick a second (stops on `extractProgress` 0 or the robot's end), and a
  low-HP tick at 30% or less. The ranged shot sounds in `RangedAttackEffect.fire`, with its beam.
- **Menus**: `Sfx.bindDom` delegates clicks and mouse hovers on the DOM UI: closing buttons
  `ui_back`, choices and chips `ui_toggle`, the rest `ui_click`. READY and the no-plays refusal are
  the lobby's own. The run card's pixi buttons click from `RunSummaryCard`.
- PROVISIONAL: gains are set from measured loudness, not by ear; a projectile's cast sound plays on
  its create, so a fireball coming into view from off-screen sounds there.

## Lobby

**The lobby replaced the enter popup** (lobby-rework, #42; mockup in the project memory,
`ideas/lobby-mockup-2026-09-30.png`). `ui/lobby/lobby.ts`: pixi draws the backdrop, the platform
and the robots (the chosen one large, aiming at the pointer, the next one dimmed); DOM over the
canvas (`lobbystyle.ts`, all `lb-` classes, placeholder chrome) carries the name pill, robot cards
(stills rendered from the rigs; pickable from their unlock level since 2026-10-01, `ui/lobby/roster.ts`,
whose class lines and taglines other than Peep's are placeholder copy), stat bars read from the
mirrored `stats`, CUSTOMIZE (head/body/limbs rows of the presets' swatches, or MIX for any colour
and pattern) and START RUN. Keys: left/right, E, Enter. It remembers robot, finish and name
(`plunderland_player_robot`, `_finish`, `_name`). Robots, preset swatches and MIX colours and patterns the level hasn't opened are disabled with an `LV n` badge (`ui/lobby/locks.ts`, pixi-free, run by `unlocks.spec.ts`; level `ACCOUNT.info?.standing?.level ?? 1`). The stored robot and finish are the wish: shown and sent as the level allows, and the robot is stored only when picked in this lobby, so a fallback (an outage, the account not yet announced, an arrow with nowhere to step) never overwrites it. A level arriving while the lobby is open re-renders it. Not done: the hangar background (art). The
header has no tabs: the LOBBY / COLLECTION stub was removed (Nick, 2026-10-15). The game is called **Plunderbots** (Nick, 2026-10-12): the wordmark, the
picker's heading and its button ("Choose Plunderbot") say so; see "Player-facing copy" below. `assets/index.html`
now declares `<meta charset="utf-8">`: without it a server that sends no charset decoded the
bundle as Windows-1252 and every non-ASCII string (the lobby's arrows) came out as mojibake.

**Layout since 2026-10-09** (Nick's mockup of that day): one CSS grid in `.lb-main`. Desktop: the hero
(canvas robot, name, class, CHOOSE PLUNDERBOT) spans the left column; on the right the callsign, "Progress"
(level, XP bar, `n / span XP` and `n XP to level L+1` from `Standing`), "Upcoming unlocks",
three action rows, the season row and READY with the plays line under it. Under 760 px it is one
column (progression, journey, hero, callsign, rows, season), READY is `position: sticky` at the
bottom of the scroll, and INVITE / settings / PRIVACY fold into the header's menu button.
The bottom-left corner shows the build's short commit (`.lb-build`, `BUILD` in `config.ts`, from
`__RELEASE__`: Workers Builds set `WORKERS_CI_COMMIT_SHA`, the itch zip build sets it by hand; `dev`
when unset), so a deploy can be checked by eye.
Four panels, one open at a time (`Lobby.toggle`): STATS & PAINT (the stat bars over the customize
rows, key E), PLUNDERBOTS (the robot cards and tagline, key C), LOADOUT (L), STASH (S). The row
"Stats & paint" is the mockup's "Loadout & stats": the skill loadout is the Skills row. The heading,
the arrows beside the robot and the key-hints line are gone (left/right still switch robots).
- **It zooms to fit the window** (`Lobby.fit`, 2026-10-09): the desktop grid needs about 900 px of
  height and most laptop windows have 600-780, which put READY below the fold. `fit` measures the
  natural height unzoomed (`lb-measure`), then sets CSS `zoom` on the root to window / natural (on
  desktop also width / `FIT_WIDTH` 1100), clamped to `FIT_MIN` (0.6 desktop, 0.75 phone; past that
  it scrolls), and sizes the root to the window divided by the zoom so it still covers it. The
  canvas robot follows through `getBoundingClientRect`, which reports zoomed sizes in Chrome and
  WebKit (both checked). **`fit` never runs inside a ResizeObserver callback**: it resizes what the
  observers watch, which is a "ResizeObserver loop" error on window.onerror; the grid's observer
  schedules it for the next frame. Measured overflow before → after (Chrome): 1366x625 274 → 0
  (zoom 0.69), 1536x730 169 → 0, 390x844 171 → 0; a 390x664 phone still scrolls 112 at 0.75.
- **Safe-area insets are zoom-aware** (g2-4): a zoomed `env(safe-area-inset-*)` shrinks with the
  zoom, which put the header and the right column 13-30 px into an iPhone's notch. `fit` sets
  `--lb-z` (the zoom) on the root, and `lobbystyle.ts` defines `--lb-sl`/`--lb-sr`/`--lb-sb` as
  `env(...) / var(--lb-z)`; the header, the short-landscape grid, the build tag and READY's bar
  pad with those, never with `env()` directly. Verified in Chromium only; if WebKit doesn't zoom
  an env() inside calc, the padding comes out 1/zoom too big (never into the notch).
  Not fixed: lobby text on a landscape phone is 4.9-6.7 px at the zoom floor (a design call).
- **No skill points exist**: the rows' status lines are facts (the kit READY plays, the first three
  stats, `stashCount` and "N new"); only the Stash row's dot lights.
- **The journey** is `journeyStop(level)` in `locks.ts` (pixi-free, `unlocks.spec.ts`): a stop is
  named Bot / Skill (a skill or loadout slot) / Reward (a colour or pattern) from the same mirrored
  rows as the locks, its title lists `unlockedBetween(l - 1, l)`. Five stops (four on a phone) from
  the account's level; the arrows scroll up to `journeyEnd()`. A robot stop shows the card's still.
- **"N new" in the stash** (`newStashCount` / `markStashSeen`, `net/stash.ts`, localStorage
  `plunderland_stash_seen`, `{ [account id]: row ids }`): an account with no record takes the stash
  as it is as seen, so nobody's whole stash shows as new on the first lobby. The stash panel being
  open marks what it shows; while rows are away in a run the old ids are kept beside the view's.
- **A browser with no token is shown Level 1** with an empty bar: the server announces no account
  before the first run makes one (`Worlds.lookup` returns null without a token). With a token it
  reads "Level ..." until the account lands, "Offline" for an offline account.

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
the Q11 reroll would go if Nick ever says yes. DISCARD (the `scrap` message) sits on every card behind a confirm. **The
client copies no merge odds**: its preview says "by chance", so `PART_MERGE_SKILL_CHANCE` has one
copy, on the server. No answer within `STASH_EDIT_WAIT_MS` (8 s) frees the buttons. Another tab's
edits show only at that tab's next `stash`.

## Player-facing copy

**The game is Plunderbots** (one word; PLUNDERBOTS in the wordmark), a playable robot a
Plunderbot. Internal names (`plunderland_*` storage keys, the party keys, file and event
names) stay: renaming a storage key loses every player's id and settings.

- Brand art is in `assets/res/brand/`, cut from Nick's logo of 2026-10-12: the wordmark (lobby
  header, `.lb-wordmark`, height-sized; the privacy page), `favicon.png` (the robot head) and
  `apple-touch-icon.png` (head on the panel navy). Its palette is the UI's: teal `#33DBD3`
  (`THEME.accent`), amber `#FCBB4C` (`THEME.loot`), cream `#EFE7D5` (letters; not yet a UI colour).
- Copy that touches progress, items or saving says what is known, not more: an unanswered
  result is NOT CONFIRMED (not UNAVAILABLE or LOST); an offline run is NOT EARNED OFFLINE;
  the stash past `STASH_SOFT` is not "full" and promises nothing (`STASH_MAX` still cuts);
  a merge or scrap whose answer can't be read says RESULT UNKNOWN.
- Merge copy is conditional at Legendary: 3 Legendary parts make a Legendary skill item, and
  a Legendary skill item can't merge (`gearpanel.ts` `itemLines`, the MERGE tooltip).
- Key captions read the bound key (`SETTINGS.value.itemKeys`), never a literal 3 or 4: the stash
  panel, and the in-run inventory tabs (`Inventory.rekey` on a settings change, as the skill cards).
- The destructive stash action is DISCARD (the `scrap`/`scrapped` messages keep their names):
  "scrap" suggested getting material back, and it gives nothing. A computer player's leaderboard
  badge is AI, since "bot" now means a Plunderbot.
- "Rarity", not "tier", in anything the player reads.
- Not yet decided (2026-10-12): Skills vs Abilities, kit/loadout, "skill item" vs Module,
  Medkit vs Repair Kit, and the eight skill names. Skill labels live in the mirrored `utils/skills.ts` and in each skill class, so a
  rename changes both packages and every class together.

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
Under the dots it draws the layer's ground (not void, walls darker, unfogged: the terrain is static
and the same for every player of a map), scaled to the ground's extent from the map's corner rather than to the map:
`hello.map` differs per world (first run 1200, private 1400, shared 4000) and a private world's
layer 01 is a 1000 square of its 1400 map, void outside (`docs/world.md`). It redraws the ground
only when the layer, the map size or the void Set (new at every `hello`) changes.

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
when `run.full` > 0, and NOT CONFIRMED after `PROGRESS_WAIT_MS`.

**The canvas renders at the screen's density** (`index.ts`: `resolution` = devicePixelRatio
capped at 2, `autoDensity`, re-read on resize). pixi's default of 1 gave a Retina screen a
half-resolution canvas stretched 2x, and everything looked soft. Layout, pointer coordinates
and `renderer.screen` stay in CSS pixels. Headless screenshots need `deviceScaleFactor: 2` to
see the difference.

An invisible plane sets `layer.visible = false` rather than sitting at alpha 0 — `visible` is
the only flag that skips PIXI's transform pass as well as the draw, and there are now about a
thousand pads behind it.

## Latency readout

Under the run clock (top centre; every corner is taken): the round trip to the server, from the
`latency` probe every 2 s (`net/latency.ts`, wire detail in `docs/wire-format.md`). Shown is the
median of the last 5 answers, so one slow packet doesn't jump the number. Green under 100 ms, amber
under 200, red from 200; grey `--` when no answer came in 6 s (an older server, a dead
connection). It is the network plus the server's event loop, not the tick: a correction can still
wait up to a tick on top of it. Nick asked for it so players can see the game cares about lag.

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
click does. **Aim is automatic on desktop and touch alike** (decision #58; the rule:
`docs/skills-and-gear.md`, "Auto-aim"): a tap or key on any skill or item casts at once, at the
auto-aim target or along the movement direction. A tap or click on an enemy targets it instead of
moving. Mouse aim and touch's arm-then-tap (`skills/touchaim.ts`, TAP TARGET) are deleted, with
no flag (#58 addendum 5); the pointer no longer aims anything in a run. **Phone HUD**
(`HUD.phone()`, either side under 520 px): the leaderboard opens and closes from the clock, the fog
legend isn't drawn; the layout is in "Phone HUD" below. **Lobby under 520 px tall** (a phone held sideways): the desktop grid, tightened; under 760 px
wide the one-column layout (see "Lobby").

**Aim line** (`vfx/aimline.ts`, #58: "a line from you to the target, with a crosshair or similar at
the target"; look by Nick's local play, PROVISIONAL until the re-test). A dotted yellow (0xFFE15A)
line, alpha 0.45, from the own robot to the target, stopping short of both, under the units
(zIndex -0.5: over the ground, threat cells and route); a crosshair of four arcs and four ticks on
the target, 0.45 cells in radius plus 1 per body ring, which **pulses (±10% at 1.6 Hz) and turns
(1.2 rad/s) while locked**. The crosshair is its own Graphics (`AimLine.cross`) with zIndex 1e7, so
it draws over every unit and prop (which sort by y), re-parented into the line's plane by `show`.
With no target: a fainter line (0.22) 2 cells along the movement direction to a still, fainter
crosshair (0.3 cells) at that point. Both are ground-plane (`onGround`) and hide with
`renderable`. `Game.updateAim` runs after `updateThreatMarker`, draws it, and turns the robot's head
and gun to the target (`Player.aimAt`, the dash exception kept); it hides and resets with no own
robot (dead, extracted, spectating, between runs). A new `AimLine` and `Aim.reset()` on every
`Game.start` and handoff.

**Cooldowns are a radial sweep over the whole button** (`ui/components/cooldownsweep.ts`, Nick's
play, #58 re-test build): a dark translucent wedge (0x05080D at 0.62) for the time left, from 12
o'clock shrinking clockwise, clipped to the card's rounded rectangle, over the icon and name and
under the seconds text, which stays in the normal text colour. It replaced dimming the icon to 0.4.
Skill cards (`SkillCard`) and gear keys 3-4 (`GearSlot`) both use it; it redraws only when the
fraction moves by 1/300 of a turn.

**Ranged charges on the press** (2026-10-04): your own robot's eye shot starts on the key press
(`RangedAttackEffect.pressed`), the server's effect no longer restarts it (the shot overlay dedupes
like actions, `RETRIGGER_S`), and the beam waits only for what is left of `SHOT.fire` since the press.
Defend stays on arrival: its protection starts at the server.

`GameObject.DEBUG_COLLIDERS` is off. It draws a magenta disc the size of the collider under
every object; the `// return` that used to switch it off had been commented out, so the
shipping game had one under everything.

## Phone HUD

Built in g2-4 (2026-11-13) after Nick's iPhone play ("inventory carousel was big overlapping with
minimap": the touch hot slot and its fan on the minimap, up to 41 px in Safari with its bars).
All in `ui/components/hud.ts` and `radial.ts`; `tools/layout-shots.mjs` measures it.

- **The split** (Nick, #62 addendum: "minimap should use up to 1/3rd right top area while controls
  would take up to 2/3 bottom right"): on a phone, the visible height after the safe-area insets
  splits at one third (`TOP_SHARE`). The minimap (80 px, smaller only if the third is shorter), the
  layer badge inside it, and the settings and fullscreen buttons left of it sit above the line.
- **The radial cluster scales into the rest** (touch): `RadialCluster.layout(..., scale)` draws the
  container at `fitScale(space under the line - 8) = min(1, space / RADIAL_HEIGHT)`, where
  `RADIAL_HEIGHT` 264 is the primary's bottom edge (24 above the safe bottom) to the hot slot's top.
  Buttons are placed in the cluster's own unscaled px, so their `Circle` hit areas scale with the
  drawing. Measured: 0.775 at 750x340 with insets (skills and items 47 px, primary 71, + toggle 23);
  about 0.74 at the shortest listed viewport (iPhone 13 mini with bars). Counts and countdowns
  keep 10 px (`floorText`). Off a phone (a tablet in touch mode) the ceiling is the bottom of the
  minimap, settings button or a right-side board instead.
- **Scales:** `HUD.scale()` (everything but the header) floors at 10/13 = 0.77 on a touch phone
  (`PHONE_TEXT_FLOOR` 10 px for `THEME.smallSize` text). **The header** (status panel, clock and
  latency, the phone leaderboard; `HUD.headerScale()`) is 0.54 on a touch phone
  (`TOUCH_PHONE_HEADER_SCALE`; Nick: "header typography definitely can be smaller. like -30% at
  least"; its smallest text is about 7 px). **Mouse play in a phone-size window** (CrazyGames'
  800x450, 821x462, 907x510 frames are phones by size) uses `MOUSE_PHONE_SCALE` 0.62 for all of it
  (Nick, option B: text 8-10 px, panels ~25% under 0.77). Elsewhere 0.5..1 by window size, as before.
- **Layer badge** (`LayerBadge.fitWidth`): its tags go one per line when the joined line is wider
  than the minimap less 10 px, so it stays inside the minimap's corner at its 10 px font (it
  stuck out 36 px).
- **The phone leaderboard** opened from the clock: in touch mode under the status panel at the
  left, never over the cluster (`placePhoneBoard` shrinks it if it would reach `leftEdge()`; it
  never does at the listed sizes); with a mouse under the minimap, right-aligned, as before. On a
  tablet the layers panel and fog legend keep left of a board beside the clock.
- The cornered clock reserves room for the fullscreen button as well as settings and the minimap.
