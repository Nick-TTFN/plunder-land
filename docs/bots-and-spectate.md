# Bots and spectate

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Bots

**Bots fill worlds** (decision #47, `src/bots/`). **Each bot has a temperament** (2026-10-04, Nick: "introduce some variation"; Claude's numbers, provisional; `TEMPERAMENTS` in `brain.ts`): steady 40% (as before: melee, ranged, defend plus fireball or icicle, `botKit`), brawler 20% (engages a ring further, scuffles to 3 rings, dashes in on a player 3-6 rings out, leaves late; melee, ranged, dash, throw), looter 20% (engages 2 closer, carries more, leaves below 45% hp, StoneWall at a chaser on the way out; ranged, defend, stone wall, throw), diver 20% (descends 2.5x as often, stays longer). A third of bots wear a random MIX finish, the rest a preset. A bot has no account and is not level-checked, and the brain presses by skill id through `Player.slotOf`, never by slot number. A bot is an ordinary `Player` from
`World.createPlayer` with no connection and a `BotBrain` as an AI routine (`player.bot`), playing
through the entry points a human's input reaches: `setWaypoints`, `tryExecuteSkill`, `tryUseItem`.
`BotFill` (one per world, run by `Worlds.tickAll` before the world's update) tops humans + bots up
to `BOT_TARGET` (default 8; 0 turns bots off; specs and the load harness pass none), only while
the world has a human; one bot joins per 2 s; a human over the target makes the least-loaded bot
leave by extracting, or exit where it stands after 90 s. **Bots are not humans anywhere a world
counts them** (`Worlds.activePlayers`: world choice and cap, idle closing, draining), write no
Redis stats and send no analytics (both guarded on `player.bot`); a human's kill on a bot counts.
They show as players with an AI tag on the leaderboard (standings flags). The brain thinks once
per its layer's `reactionMs` (`BOT_SKILL`: 900/450/300 ms, aim missing by a cell 60/25/12% of the
time; layer 01 weaker since #58 addendum 4): heal when hurt, fight the nearest human in reach (but not in the first 10 s of the
human's run, `SPAWN_GRACE_MS`) and another bot or a mob only within 2 cells, head out once loaded or late (`lootGoal` 1500-4000, `deadline` 3-8 min, both
provisional), loot what it sees, else wander and sometimes descend. Measured 2026-10-02 in
`bots.spec.ts`'s ten simulated minutes: runs of about 2 min median, most deaths on layers 02-03;
about 0.013 ms of tick per bot. Natural loot refills every tick, so a bot carried 400-1200 loot
within 20-100 s: run length is decided by time, not loot.
**Bots join on a layer, as a robot from that layer's range** (#58 addendum 2 Q6, task retest-7).
`BOT_SKILL` (`brain.ts`) is one row per layer, top first: reaction, aim miss, engage, descend, plus
`robots`, `temperaments` and `cargo`. Layer 01: Peep, Magnet, Periscope; steady, looter, diver (no
brawler: weights steady 50 / looter 25 / diver 25, `pickTemperament` weighs steady 2 and the rest 1
over the allowed list); cargo 25% T1. Layer 02: those plus Hopper; all four temperaments (40/20/20/20);
25% T1. Layer 03: Magnet, Periscope, Hopper, Waddle; all four; cargo 40% T2. `BotFill.layerFor`
picks the layer whose humans have the fewest staying bots per human (ties to the top; a layer with
no human gets none), and `spawn` draws robot, temperament and cargo from its row and joins it there
(`World.createPlayer(..., kit, tag)` at `spawnCell(tag)` with the normal clearance; a human join
passes no tag and lands on the top layer). The fill's target is per world, and an over-target bot is retired by least loot. **A private world's target follows its human's layer** (#60 addendum 2026-11-07, Nick: "a couple in layer 1, 3-4 on layer2"): 2 bots while the human is on layer 01, 3 on layer 02 (`PRIVATE_BOTS_DEFAULT` in `network/worlds.ts`; env `PRIVATE_BOTS`, a comma list of bots per private layer top first, "0" turns them off; it replaced the never-deployed `PRIVATE_BOT_TARGET`, which counted humans + bots). `Worlds.tickAll` sets the fill's `target` to humans + that count each tick (`privateBotsFor`), so on a descent the old layer's bots leave (below) and three join beside the human. **Bots follow the humans** (#60 Q8): a staying bot on a layer with no human in play heads out (extract, then exit at `LEAVE_GRACE_MS`), and the fill tops up on the human's layer (`layerFor`); a bot's deliberate descend also requires a human on the layer below (`humanOn`, `brain.ts`), or most divers were sent out on landing. A route that only happens to end on a portal (a wander, a walk to loot) is not refused, and the hop is retired. **Handicap** (#60 Q7): `BOT_SKILL`'s `hpScale` and `damageScale` (0.5 / 0.75 / 1, top first; 1 for any deeper row) apply once at the join (`BotFill.handicap`, by `bot.tag`): max HP and max armor rounded, at least 1, filled; damage through `Player.botDamage`, multiplied into the `damageScale` getter and so into `Skill.dealt`. Kept across layer changes. Armor refill per second and the medkit amount are not scaled. It holds only because a bot never equips gear: `applyGear` rebuilds max HP and armor from the archetype.
**A bot never walks into a layer whose `robots` leave its robot out** (`robotAllowedOn`): the
deliberate descend is gated, `go()` refuses any route ending on a portal into such a layer (it
halts; loot and exit fall back to a wander), each think re-checks the current route, and a brawler
presses Dash only when `go` returned a non-empty route (a standing dash along `facing` would hop a
portal cell, `Unit.dashCells`). Any route crossing a portal's cell takes it (`Unit.endAtPortal`,
`Player.hopPortal`), up or down, which is why the guard is needed. **Known gap:** a re-plan between
two thinks (only `World.addObstacle` re-plans off-think, a stone dropped on the route) can still
carry a bot onto such a portal within 300-900 ms; the source fix, if wanted, is a bot-only
`Player.blocks` override for barred portal cells (retest-7 review).

**A share of bots join carrying cargo** (#49, 49-6; chance and tier per layer in `BOT_SKILL`'s
`cargo`, above; `BOT_CARGO` in `brain.ts` keeps only the skill share: skill item 30% else a part):
one rowless item in the bag, given in `BotFill.spawn` after
`player.bot` is set (before it, `addGear` would equip a skill item and change the bot's stats).
A bot never picks gear up (`Player.gearRoom`, decision #57), keeps its cargo in the bag and never casts gear; it drops it all on death like a
player, and its extraction loses found gear and deletes stash rows it carried (`discardGear`).

## Spectate

**A dead player watches its killer, then whoever is nearest** (decision #47). The server keeps
the dead player's connection: `Connection.spectating` is the watched player,
`Player.spectators` its watchers, and **`Multiplayer.viewpoint`** (the watched player, else the
connection's own) stands in for `connection.player` wherever a view is tested (`inView`,
`sendVisible`, `switchLayer`, the holders loop). The interest loops serve a candidate's
spectators beside its own connection (`viewersOf`, static scratch arrays). Death re-centres the
view as a layer change does; when the watched run ends, on to the nearest live player (same
layer first, bots included), or stop (`spectate` `{ id: null }`). The client is told whom it
follows with a plain `spectate` `{ id, name }` event, text, which framed clients still decode;
its camera, fog and shown plane follow that unit (`Game.SPECTATE_ID`). The run card gets SPECTATE,
and a SPECTATING bar (RUN SUMMARY, BACK TO LOBBY) sits above the popups. No spectate after an
extraction. `forget` ends any spectating (a new run, a move to another world, a disconnect).
The view itself is the watched robot's: the server sends by its vision (see "Who gets what")
and the client's fog follows it (`Fog.setRadius`), since #48.
