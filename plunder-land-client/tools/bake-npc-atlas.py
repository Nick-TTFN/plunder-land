#!/usr/bin/env python3
"""
Bake an NPC's rig parts into `assets/res/npc-<npc>.png` + `npc-<npc>.json`
(l1-8, decision #51): the Crawler and the Broodling; the Reactor, the
Compactor, the Kiln, the Coil and the Brood since l1-9 (PROVISIONAL: their
packages await Nick's art review, so expect to re-bake them).

    python3 tools/bake-npc-atlas.py <npc> [package-dir]    # crawler, broodling, reactor, compactor, kiln, coil, brood

The source is the NPC's Codex package, not checked in (like every art drop):
`rig/parts.json` names each part's PNG (`art/<part>.png`, `parts/<part>.png`)
and its size. The
rig places every image by a matrix from the art's own pixels to rig units
(`NpcImage.m`, `src/npcs/npcrig.ts`), so a texture of any resolution fits;
`NpcSprite` stretches each frame to the art's full size. Each part is
resampled once, from the full-size art, to the most it is ever drawn at:

    texels = art px x (rig units per art px, at most) x TEXELS_PER_UNIT x sizeScale

`TEXELS_PER_UNIT` is the robots' (`bake-peep-atlas.py`): 2 x
`RobotSprite.PEEP_HEIGHT` (53) over Peep's 245.5 reference units, a texel per
device pixel on a 2x screen (the sheet is at scale 2). `SIZE_SCALE` is the
NPC's `sizeScale` (Nick, 2026-10-09 size review: Crawler 1.31, Broodling 1.49,
Reactor 2.92, Compactor 1.78, Kiln 1.65, Coil 2.32, Brood 3.2, then 2.5 for its
ring footprint; 2026-10-07 was
0.89, 0.94, 2.11, 1.00, 1.00, 1.21, 2.06): change both together.

The units per pixel are the evaluators', and each is the largest the part
reaches, so nothing is ever drawn bigger than its texture:

- Crawler (`tools/rig.mjs`): the body is 85 units across its 414 px
  (`composePose`; its height follows, times 1 - pitch / tilt, which a
  forward pitch can raise by at most a few percent); the upper leg is 44
  units between anchors 429 px apart, the lower 64 between anchors 552.4 px
  apart, both at their longest, with the leg in the picture plane; the knee
  joint 15 units across 300 x 305 px.
- Broodling (`tools/broodling.mjs`): every length times its `renderScale`
  1.12. The body 38 units across 1052 px; the upper and lower legs 13 and 18
  units between the same anchors as the Crawler's (the art is the Crawler's);
  the knee joint 5 units, the hip 4.8.
- Reactor (`tools/reactor.mjs`): every part at 4 px a unit, only turned (its
  plates never stretch); the shadow at most 120 x 58 units over 256 x 128 px
  (the body's). Its `aperture-mask` is baked white and untrimmed: pixi's
  sprite mask reads the red channel, and the package's mask is black.
- Compactor (`tools/rig.mjs`): the largest units per pixel over every pose
  in `compactor.fixtures.json` (measured, 2026-10-07): the body and sensor
  116 / 476 (and 0.2444 down, a hit's pitch); the upper and lower legs
  0.1258 and 0.1479 (their screen length can pass their 48 and 70 units);
  the joints 15 / 300; the piston parts 1 / 8; the shadows 1.305 x 1.219 and
  0.1313 x 0.1365. The shaft and the front legs' roots are cropped at draw
  time (`NpcSprite.cut`), from the whole part.
- Kiln, Coil, Brood (l1-9): likewise the largest over every pose in their
  fixtures (measured, 2026-10-07), rounded up. The Kiln's furnace atlases and
  the Brood's lamp atlases are not baked: the ports draw them in code (see
  their `rig.ts`), so only the Kiln's cold cavity (`furnace-off`) and shadow,
  and the Brood's lens covers (`lowerOff`, `lowerDead`), come from the
  packages' effect PNGs. The Kiln's parts are named by their PNG (its
  `parts.json` lists bindings: `leg_-1_1_root` draws `upper`); the Brood's
  PNG paths are relative to `rig/`.

The Crawler's fall_apart splits its shell into three row bands of the body
art (`SHELLS` in `src/npcs/crawler/rig.ts`); each band is its own frame,
`body-<top row>`, cut from the full art before resampling.

Frames are trimmed of transparent borders (pixi restores the full size from
`sourceSize`). Palette-quantised with pngquant and oxipng when installed.
"""
import json
import math
import os
import shutil
import subprocess
import sys

from PIL import Image

DROPS = os.path.join(os.path.dirname(__file__), '..', 'codex_output')
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'res')
PADDING = 2

# Keep in step with RobotSprite.PEEP_HEIGHT and PEEP_RIG.referenceUnits.
DISPLAY_HEIGHT = 53
REFERENCE_UNITS = 245.5
TEXELS_PER_UNIT = 2 * DISPLAY_HEIGHT / REFERENCE_UNITS

# The Crawler's pitch is under 0.1 rad in every clip; 1 - pitch / 0.68 stays under 1.15.
CRAWLER_BODY = 85 / 414
BROODLING = 1.12

NPCS = {
    'crawler': {
        'package': 'crawler-animations-v4',
        'size_scale': 1.31,
        # part -> (rig units per art px across, down)
        'parts': {
            'body': (CRAWLER_BODY, CRAWLER_BODY * 1.15),
            'upper': (44 / 429, 44 / 429),
            'lower': (64 / math.hypot(546, 84), 64 / math.hypot(546, 84)),
            'joint': (15 / 300, 15 / 305),
        },
        # (art, top row, rows): fall_apart's shell sections.
        'bands': [('body', 0, 149), ('body', 149, 280), ('body', 429, 152)],
    },
    'broodling': {
        'package': 'npc-refinements/broodling-v3',
        'size_scale': 1.49,
        'parts': {
            'body': (38 / 1052 * BROODLING, 38 * 1069 / 1052 / 1069 * BROODLING),
            'upper': (13 / 429 * BROODLING, 13 / 429 * BROODLING),
            'lower': (18 / math.hypot(546, 84) * BROODLING, 18 / math.hypot(546, 84) * BROODLING),
            'joint': (5 / 300 * BROODLING, 5 / 305 * BROODLING),
        },
        'bands': [],
    },
    # PROVISIONAL (l1-9): reactor-v6, delivered 2026-10-07, not yet approved by Nick.
    'reactor': {
        'package': 'npc-refinements/reactor-v6',
        'size_scale': 2.92,
        'parts': {
            **{part: (0.25, 0.25) for part in [
                'shell', 'chamber', 'core', 'core-off', 'core-emission', 'ribs', 'rim',
                'shutter0', 'shutter1', 'shutter2', 'hip', 'knee', 'aperture-mask',
                *[f'{seg}{i}' for i in range(6) for seg in ('upper', 'lower')]]},
            'shadow': (120 / 256, 58 / 128),
        },
        'bands': [],
        # Baked white and untrimmed: a sprite mask (see above).
        'masks': ['aperture-mask'],
    },
    # PROVISIONAL (l1-9): compactor-v4, delivered 2026-10-07, not yet approved by Nick (v3 was).
    'compactor': {
        'package': 'npc-refinements/compactor-v4',
        'size_scale': 1.78,
        'parts': {
            'compactor': (116 / 476, 0.2444),
            'sensor-base': (116 / 476, 0.2444),
            'sensor-lit': (116 / 476, 0.2444),
            'sensor-off': (116 / 476, 0.2444),
            'upper': (0.1259, 0.1259),
            'lower': (0.1480, 0.1480),
            'joint': (15 / 300, 15 / 300),
            'shoe': (1 / 8, 1 / 8),
            'shaft': (1 / 8, 1 / 8),
            'cog': (1 / 8, 1 / 8),
            'cog-back': (1 / 8, 1 / 8),
            'bearing': (1 / 8, 1 / 8),
            'shoe-shadow': (0.1314, 0.1366),
            'shadow': (1.305, 1.219),
        },
        'bands': [],
    },
    # PROVISIONAL (l1-9): kiln-v3, delivered 2026-10-07, not yet approved by Nick (v2 was).
    'kiln': {
        'package': 'npc-refinements/kiln-v3',
        'size_scale': 1.65,
        'parts': {
            'base': (0.1365, 0.1399),
            'canister': (0.1642, 0.1678),
            'upper': (0.1266, 0.1266),
            'lower': (0.1440, 0.1440),
            'joint': (0.05, 0.0492),
            'furnace-off': (0.3344, 0.3417),
            'shadow': (0.5513, 0.6094),
        },
        'bands': [],
    },
    # PROVISIONAL (l1-9): coil-v5, delivered 2026-10-07, not yet approved by Nick (v4 was).
    'coil': {
        'package': 'npc-refinements/coil-v5',
        'size_scale': 2.32,
        'parts': {
            **{part: (0.095, 0.095) for part in ['body', 'dark', 'heat', 'bloom']},
            'upper': (0.0844, 0.0844),
            'lower': (0.0972, 0.0972),
            'foot': (0.0561, 0.0561),
            'rearfoot': (0.0351, 0.0351),
            'shadow': (0.25, 0.25),
            'foot-shadow': (0.25, 0.25),
            'rear-shadow': (0.25, 0.25),
            'ring': (0.125, 0.125),
            'ring-charge': (0.125, 0.125),
            'local-glow': (0.125, 0.125),
        },
        'bands': [],
    },
    # PROVISIONAL (l1-9): brood-v15, delivered 2026-10-07, not yet approved by Nick (v14 was).
    'brood': {
        'package': 'npc-refinements/brood-v15',
        # 3.2 -> 2.5 (ring footprint, #52 open item 6): fits its 7-cell body.
        'size_scale': 2.5,
        'parts': {
            'body': (0.145, 0.145),
            'upper': (0.0761, 0.0761),
            'lower': (0.0897, 0.0897),
            'lowerOff': (0.0897, 0.0897),
            'lowerDead': (0.0897, 0.0897),
            'joint': (0.0429, 0.0437),
        },
        'bands': [],
    },
}


def bake():
    args = sys.argv[1:]
    if not args or args[0] not in NPCS:
        sys.exit(f'usage: bake-npc-atlas.py <{"|".join(NPCS)}> [package-dir]')
    npc = args.pop(0)
    spec = NPCS[npc]
    source = args[0] if args else os.path.join(DROPS, spec['package'])
    parts = json.load(open(os.path.join(source, 'rig', 'parts.json')))
    # By id, and by the PNG's own name (the Kiln's ids are bindings).
    pngs = {os.path.splitext(os.path.basename(p['png']))[0]: (p['png'], tuple(p['size'])) for p in parts['parts']}
    pngs.update({p['id']: (p['png'], tuple(p['size'])) for p in parts['parts']})

    def path_of(file):
        # The Brood's paths are relative to `rig/parts.json`.
        return os.path.normpath(os.path.join(source, 'rig', file) if file.startswith('../') else os.path.join(source, file))
    density = TEXELS_PER_UNIT * spec['size_scale']
    out_name = f'npc-{npc}'
    tiles = {}

    masks = spec.get('masks', [])

    def add(name, art, box, part):
        """`art` (part `part`) cut to `box` (left, top, right, bottom in art px), resampled to its largest drawn size."""
        image = art.crop(box)
        ux, uy = spec['parts'][part]
        size = (max(1, round(image.size[0] * ux * density)), max(1, round(image.size[1] * uy * density)))
        if part in masks:
            # A mask: its alpha, on white (pixi's sprite mask multiplies by red).
            white = Image.new('RGBA', image.size, (255, 255, 255, 0))
            white.putalpha(image.getchannel('A'))
            image = white
        # Premultiplied, so transparent pixels' colour doesn't bleed into edges.
        small = image.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA')
        trim = (0, 0) + size if part in masks else small.getchannel('A').point(lambda a: 255 if a > 2 else 0).getbbox() or (0, 0, 1, 1)
        tiles[f'{out_name}/{name}.png'] = (small.crop(trim), size, trim)

    for name in spec['parts']:
        file, size = pngs[name]
        art = Image.open(path_of(file)).convert('RGBA')
        if art.size != size:
            sys.exit(f'{file} is {art.size}, parts.json says {size}')
        add(name, art, (0, 0) + art.size, name)
    for name, top, rows in spec['bands']:
        art = Image.open(path_of(pngs[name][0])).convert('RGBA')
        add(f'{name}-{top}', art, (0, top, art.size[0], top + rows), name)

    frames, (sw, sh) = pack({n: t[0] for n, t in tiles.items()}, 256)
    sheet = Image.new('RGBA', (sw, sh), (0, 0, 0, 0))
    for name, (image, size, box) in tiles.items():
        f = frames[name]
        sheet.paste(image, (f['frame']['x'], f['frame']['y']))
        f['trimmed'] = True
        f['spriteSourceSize'] = {'x': box[0], 'y': box[1], 'w': image.size[0], 'h': image.size[1]}
        f['sourceSize'] = {'w': size[0], 'h': size[1]}

    png = os.path.join(OUT, f'{out_name}.png')
    sheet.save(png)
    optimise(png)
    with open(os.path.join(OUT, f'{out_name}.json'), 'w') as out:
        json.dump({
            'frames': frames,
            'meta': {
                'app': 'tools/bake-npc-atlas.py',
                'version': '1.0',
                'image': f'{out_name}.png',
                'format': 'RGBA8888',
                'size': {'w': sw, 'h': sh},
                'scale': '2',
                'texelsPerUnit': density,
                'package': spec['package'],
            },
        }, out, indent=1)
    print(f'{out_name}.png {sw}x{sh}, {len(frames)} frames, {os.path.getsize(png)} bytes')


def optimise(png):
    """Palette-quantise if the tools are around; see bake-hex-atlas.py."""
    for command in (
        ['pngquant', '--quality=60-95', '--speed', '1', '--force',
         '--output', png, '256', png],
        ['oxipng', '-o', '4', '--strip', 'safe', '--quiet', png],
    ):
        if shutil.which(command[0]) is None:
            print(f'{command[0]} not installed - shipping an unoptimised sheet')
            continue
        subprocess.run(command, check=True)


def pack(tiles, width):
    """Shelf packing, tallest first, `PADDING` clear on every side."""
    order = sorted(tiles, key=lambda n: (-tiles[n].size[1], n))
    frames = {}
    x = y = PADDING
    shelf = 0
    for name in order:
        w, h = tiles[name].size
        if x + w + PADDING > width:
            x = PADDING
            y += shelf + PADDING
            shelf = 0
        frames[name] = {
            'frame': {'x': x, 'y': y, 'w': w, 'h': h},
            'rotated': False,
            'trimmed': False,
            'spriteSourceSize': {'x': 0, 'y': 0, 'w': w, 'h': h},
            'sourceSize': {'w': w, 'h': h},
        }
        x += w + PADDING
        shelf = max(shelf, h)
    return frames, (width, y + shelf + PADDING)


if __name__ == '__main__':
    bake()
