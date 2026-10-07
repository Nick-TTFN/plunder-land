#!/usr/bin/env python3
"""
Bake the NPC effects library into `assets/res/npc-fx.png` + `npc-fx.json`
(task l1-11, decision #51: "source everything from codex", effects included).

    python3 tools/bake-npc-fx-atlas.py [package-dir]

The source is Codex's `npc-fx-v1` package, not checked in (like every art
drop; `codex_output/` is gitignored). Its `docs/INTEGRATION.md` is the
artist's contract and builds on the arena library's
(`tools/bake-arena-atlas.py`, `docs/art-pipeline.md`): frames at 2x logical
size, the pivot normalised per asset, one clip per id with its fps and loop.
PROVISIONAL: the package is a review candidate Nick has not approved, so
expect a re-bake after his art review.

Unlike the arena bake, the ids are not listed here: every asset in the
package's `manifest.json` is baked (all seventeen are drawn by
`src/vfx/npcfx.ts`), so a new or renamed clip in a re-delivery needs no edit
here, and `textures.spec.ts` (server) fails on a name the client asks for
that the sheet no longer has.

The sheet is a PIXI spritesheet at **scale 2**, like `arena.json`. Each
frame carries the asset's pivot as its `anchor`. Animations are named
`fx/<id>`, frames `fx/<id>_NN.png` in the package's order. `meta.clips`
holds each clip's `fps` and `loop` (what `AnimationClip` reads), plus
`ground`: true for a decal that lies on the floor (the package's
`plane: "ground"`), which the client marks `onGround` so the camera's tilt
squashes it once; false for a standing burst, which must not be squashed.
The Compactor's wave cell also carries the package's `chain` (the delay
before the next cell along the line starts), so no client code holds the
number.

Frames are packed with the arena bake's own `clip`, `pack`, `write` and
`optimise` (imported, not copied), so the format is the arena sheets' to the
byte; pngquant and oxipng when installed.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SOURCE = os.path.join(HERE, '..', 'codex_output', 'npc-fx-v1')
WIDTH = 2048

spec = importlib.util.spec_from_file_location('bake_arena_atlas', os.path.join(HERE, 'bake-arena-atlas.py'))
arena = importlib.util.module_from_spec(spec)
spec.loader.exec_module(arena)


def bake():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    manifest = json.load(open(os.path.join(source, 'manifest.json')))
    assert manifest.get('scale') == 2, f'manifest scale {manifest.get("scale")}, this bake writes scale 2'

    tiles, animations, clips = {}, {}, {}
    for a in manifest['assets']:
        name = 'fx/' + a['id']
        assert a['plane'] in ('ground', 'standing'), f'{a["id"]}: plane {a["plane"]!r}'
        assert a['onGround'] == (a['plane'] == 'ground'), f'{a["id"]}: plane and onGround disagree'
        animations[name] = arena.clip(source, a, name, tiles)
        clips[name] = {'fps': a['fps'], 'loop': a['loop'], 'ground': a['plane'] == 'ground'}
        if 'chain' in a:
            clips[name]['chain'] = {'cellDelay': a['chain']['cellDelay']}

    arena.write('npc-fx', tiles, animations, WIDTH, {
        'app': 'tools/bake-npc-fx-atlas.py',
        'source': f'{manifest["name"]} v{manifest["version"]} ({manifest["date"]}, {manifest["status"]})',
        'clips': clips,
    })


if __name__ == '__main__':
    bake()
