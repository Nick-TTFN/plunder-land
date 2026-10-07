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
They show as players with a BOT tag on the leaderboard (standings flags). The brain thinks once
per its layer's `reactionMs` (`BOT_SKILL`: 650/450/300 ms, aim missing by a cell 45/25/12% of the
time): heal when hurt, fight the nearest human in reach (but not in the first 10 s of the
human's run, `SPAWN_GRACE_MS`) and another bot or a mob only within 2 cells, head out once loaded or late (`lootGoal` 1500-4000, `deadline` 3-8 min, both
provisional), loot what it sees, else wander and sometimes descend. Measured 2026-10-02 in
`bots.spec.ts`'s ten simulated minutes: runs of about 2 min median, most deaths on layers 02-03;
about 0.013 ms of tick per bot. Natural loot refills every tick, so a bot carried 400-1200 loot
within 20-100 s: run length is decided by time, not loot.
**A quarter of bots join carrying cargo** (#49, 49-6; `BOT_CARGO` in `brain.ts`: chance 0.25,
skill item 30% else a part, tier 1): one rowless item in the bag, given in `BotFill.spawn` after
`player.bot` is set (before it, `addGear` would equip a skill item and change the bot's stats).
A bot puts everything it picks up in the bag and never casts gear; it drops it all on death like a
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
its camera, fog and shown plane follow that unit (`Game.SPECTATE_ID`). The run card gets WATCH,
and a SPECTATING bar (RUN CARD, PLAY AGAIN) sits above the popups. No spectate after an
extraction. `forget` ends any spectating (a new run, a move to another world, a disconnect).
The view itself is the watched robot's: the server sends by its vision (see "Who gets what")
and the client's fog follows it (`Fog.setRadius`), since #48.
