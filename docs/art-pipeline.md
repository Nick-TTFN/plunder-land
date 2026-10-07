# Art pipeline

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## The hex sheet is generated, and its sources are not in the repo

`assets/res/hex.png` + `hex.json` are baked by `tools/bake-hex-atlas.py` from two 1254x1254
art drops that live **outside** the repo (`~/.codex/.chatgpt-projects/.../assets/hex_tileset`,
the `pixel-art-clean-alpha` pair). They are ~5 MB each against a 3.4 MB repo, so only the
48 KB output is committed. Re-bake with:

```
cd plunder-land-client && python3 tools/bake-hex-atlas.py [source-dir]
```

It needs `pillow` and `numpy`, and uses `pngquant` + `oxipng` if they are installed — they
take the sheet from 193 KB to 48 KB with no visible difference, and it warns and ships the
larger file if they are missing.

The script owns three things worth knowing before touching either sheet:

- **Pads are baked to their exact on-screen size** for `Hex.SIZE = 45` (`HexTerrain.BAKED_FOR`),
  because the game draws at 1:1 with `ROUND_PIXELS` and a texture baked to size never gets
  resampled. Change `Hex.SIZE` and the pads still tile - `HexTerrain` rescales them - but
  they stop being crisp. Re-bake instead.
- **A pad is a regular hexagon 7% larger than the lattice.** The art is 4.5% short of regular,
  and tiling a short hex leaves a transparent notch on every diagonal edge; the 7% is what
  makes neighbours overlap once positions are rounded to whole pixels.
- **Both sheets' 6x6 grids are measured, not assumed.** Neither is on the clean 209 px pitch
  the image size implies, and one prop has a stray pixel that reads as a seventh row.

## Camera, ground and arena sheets

**The camera is tilted, in drawing only** (`src/objects/tilt.ts`, tile art pass 2026-09-27).
`Game.CONTAINER.scale.y = TILT` (about 0.924: the art's 0.93 rounded so a tilted row is exactly 36 px; 0.744 until the flat-tile pass), so a world `y` draws at `y * TILT`; rules, wire and
server stay on the regular top-down grid, and `toLocal` undoes the squash for the pointer and
the aim. Anything **added straight to the camera or a plane stands up**: `TiltedContainer`
gives it an `UprightTransform`, which squashes its position and not its shape, and keeps its
own `scale` (and tweens on it) meaning what they did. Things that lie on the ground are marked
`onGround` and squash with it: the planes, `PathMarker`, `ThreatMarker`, `CellHighlight`, the
ranged beam. A new ground-plane overlay needs `onGround`, or it draws unsquashed.

**The ground pads are a separate sheet, `assets/res/ground.png` + `ground.json`**, baked by
`tools/bake-ground-atlas.py` from an art drop kept outside the repo
(`~/.codex/.chatgpt-projects/.../output/hex-arena/pointy-top-tiles-v1`: 12 flat top faces in
`transparent-top-faces/`, their vertices in `manifest.json`, and `edge-fade.png`): steel faces,
surface (satin, faceted, brushed, patched) by edge (clean, worn, chipped). It is baked **at 2x** (`meta.scale: 2`, linear filtering) and **already
squashed by `TILT`** (`meta.tilt`; the client warns on a mismatch), since `HexTerrain` stands up
and lays its rows at `TILT` of their pitch itself, which keeps pads texel for pixel. The bake
remaps each face band by band from the manifest's vertices onto a regular hex one cell wide
squashed by `TILT`; no overscale, so the bevels are the grid line. A known cell (visible or
explored) is a flat face; **under each of its two lower edges whose neighbour below is unknown
(void, valley or off the map), `HexTerrain` hangs that half of the edge fade** (`fade_left` /
`fade_right`, the fade cut at its apex, tinted `HexTerrain.FADE_TINT` times the fog and layer
tints, at `HexTerrain.FADE_ALPHA` 0.5). Cells never seen are the sheet's outline frame on the lattice; void cells (`HexTerrain.voidOf`: valleys and off the map) are that outline while unseen and **nothing at all once seen**. Three layers, back to front:
outlines, fades, faces, so a fade only ever shows over void.

**Why the ground doesn't wobble:** PIXI's `roundPixels` rounds to `settings.RESOLUTION` (1),
not the renderer's 2x, and with a fractional row pitch every row snapped differently. So pads
are not rounded; every pad lands on a whole device pixel by construction (column 45, row shift
22.5, row `ROW_SCREEN` 36, all face frames the same size with the face centre on a whole texel), and
the camera and `Game`'s own position are snapped to device pixels. Break any one and it wobbles. Every layer uses the same
set, tinted by `LAYER_TINT` (`objects/fog.ts`) times the fog's. The old `hexpad/*` frames in
`hex.json` are now unused and go at its next re-bake.

**Props, effects and icons are a third generated sheet, `assets/res/arena.png` + `arena.json`,
and the two blasts are a fourth, `blasts.png` + `blasts.json`** (arena art pass 2026-09-28),
baked by `tools/bake-arena-atlas.py` from an art drop kept outside the repo
(`~/.codex/.chatgpt-projects/.../output/extraction-arena-library-v2`; its `docs/INTEGRATION.md`
is the artist's contract). Scale 2 like the ground; each frame carries the drop's pivot as its
`anchor`, so sprites are drawn at scale 1 on their ground point and no client code knows a
pivot number. Clips list their fps and loop in `meta.clips`, which `AnimationClip` reads (it
searches `atlas.json`, then the arena sheets). Portal and extract pad are **pre-squashed for
the tilt**: they stand up, never `onGround`, or they squash twice. Skill icons are resampled
256 to 68 px. The enter-screen panel and button chrome in the drop are not baked; they wait
for the robot-preview milestone. JetBrains Mono (the HUD's `THEME.font`) ships in
`assets/res/fonts/` with its OFL licence; `index.ts` waits for it, and starts without it.
Loot crystals are picked by value (`Consumable.TIERS`: under 25 small, under 50 medium, else
large), which is why a pickup's create carries `loot` since this pass.

## Unused assets

`tiles/grass.png`, `tiles/ground.png`, `cloud.png` (since the airborne plane went), `exit.png`,
`portal.png`, `fireball/*`, `explosion/*`, `resource/*`, the `UI/controls/*` icons and the
four `obstacle_*` groups in the TexturePacker atlas are now unused, and so are the `hexprop/*`
frames in `hex.json`. They stay
because regenerating that atlas needs TexturePacker, which is not in this toolchain; that is
about 40 KB of the 327 KB atlas sitting there for nothing.
