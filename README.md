# plunder-land

## Overview

Plunderland is a multiplayer **extraction game**. A persistent world runs continuously;
players drop in at a random point, fight mobs and each other for loot, and try to reach an
`Exit` to bank the run. Dying scatters everything you were carrying on the ground for
someone else to take.

The world is three vertically stacked planes connected by portals. Two are built; the
third (airborne) plane is designed but unpopulated.

## Status

Pre-release and not currently deployed. The game runs locally — see `CLAUDE.md` for the
build, run and smoke-test recipe, and for the list of what is designed but not yet wired
(loot banking, the six unequipped skills, the level curve, the third plane).

## Tech

- **Client** — TypeScript, Pixi.js v7, socket.io-client, webpack
- **Server** — Node.js, socket.io, Redis (cumulative player stats only), a fixed 250ms
  simulation tick
- **Protocol** — custom binary; see `docs/wire-format.md`

## History

Earlier versions carried a play-to-earn layer: an on-chain LOOT token entry fee, NFT gear,
and an `evm-connector` service talking to Aurora via thirdweb. **All of it has been
removed.** Players are identified by an anonymous per-browser id with no account and no
wallet. The name "battle-royale-server" is a leftover from an even earlier direction that
was never built — there is no round, lobby or shrinking play area anywhere in the code.
