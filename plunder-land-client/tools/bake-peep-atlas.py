#!/usr/bin/env python3
"""
Bake Peep's rig parts into `assets/res/peep.png` + `peep.json` (2026-09-30).

The source is the v15 rig drop, which is not checked in (like the other art
drops): its painted parts in the default finish, and the eye sprites.

    <drop>/composed/<art>.png         thigh, shin, boots, torso, arms, hand, blaster, head
    <drop>/eye/open.png, smile.png    the eye, in the head art's pixels (144 x 198)
    <drop>/eye/visor-reflection.png   over the eye, the head art's size

    python3 tools/bake-peep-atlas.py [drop-dir]

The drop's images are far larger than the game draws them (the head is 428 px
for about 70 on screen) and each part is a different number of pixels per rig
unit. The rig never reads an image's size: it draws every part into a box in
rig units (`REGIONS` in `src/peep/rig.ts`). So each part is resampled once,
from the full-size art, to its box at `TEXELS_PER_UNIT`, and the client fits
whatever texture it gets into the box. A mismatch here costs sharpness, not
position.

`TEXELS_PER_UNIT` is `PeepSprite`'s display scale times 2: Peep is drawn
`PeepSprite.HEIGHT` (44) CSS px tall for the reference pose's 245.5 units, and
the sheet is at **scale 2** like the arena sheets, so a 2x screen gets a texel
per pixel. Change the height there and re-bake here.

Frames are trimmed of transparent borders (PIXI restores the full size from
`sourceSize`), so centring the sprite on its box still works.
"""
import json
import os
import shutil
import subprocess
import sys

from PIL import Image

DEFAULT_SOURCE = os.path.join(os.path.dirname(__file__), '..', 'codex_output', 'peep-animations-v15')
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'res')
PADDING = 2

# Keep in step with PeepSprite.HEIGHT / PeepSprite.REFERENCE_UNITS.
DISPLAY_HEIGHT = 44
REFERENCE_UNITS = 245.5
TEXELS_PER_UNIT = 2 * DISPLAY_HEIGHT / REFERENCE_UNITS

# art -> (file in the drop, box in rig units). The box is the largest any
# region draws that art at (`REGIONS` in src/peep/rig.ts: the thighs are 15
# and 16 wide). The eye's is its 144 x 198 head-art pixels at 178/428 and
# 159/388 units per pixel. `composed/arm_far.png` is not drawn by any region.
ARTS = {
    'thigh': ('composed/thigh.png', (16, 23)),
    'shin': ('composed/shin.png', (15, 24)),
    'boot_far': ('composed/boot_far.png', (57, 44)),
    'boot_near': ('composed/boot_near.png', (62, 47)),
    'forearm_far': ('composed/forearm_far.png', (29, 35)),
    'torso': ('composed/torso.png', (76, 68)),
    'arm_near': ('composed/arm_near.png', (28, 39)),
    'head': ('composed/head.png', (178, 159)),
    'hand_far': ('composed/hand_far.png', (29, 35)),
    'blaster': ('composed/blaster.png', (55, 30)),
    'eye_open': ('eye/open.png', (144 * 178 / 428, 198 * 159 / 388)),
    'eye_smile': ('eye/smile.png', (144 * 178 / 428, 198 * 159 / 388)),
    'visor_reflection': ('eye/visor-reflection.png', (178, 159)),
}


def bake():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    tiles = {}
    for art, (file, (w, h)) in ARTS.items():
        image = Image.open(os.path.join(source, file)).convert('RGBA')
        size = (max(1, round(w * TEXELS_PER_UNIT)), max(1, round(h * TEXELS_PER_UNIT)))
        # Premultiplied, so transparent pixels' colour doesn't bleed into edges.
        small = image.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA')
        box = small.getchannel('A').point(lambda a: 255 if a > 2 else 0).getbbox() or (0, 0, 1, 1)
        tiles[f'peep/{art}.png'] = (small.crop(box), size, box)

    frames, (sw, sh) = pack({n: t[0] for n, t in tiles.items()}, 512)
    sheet = Image.new('RGBA', (sw, sh), (0, 0, 0, 0))
    for name, (image, size, box) in tiles.items():
        f = frames[name]
        sheet.paste(image, (f['frame']['x'], f['frame']['y']))
        f['trimmed'] = True
        f['spriteSourceSize'] = {'x': box[0], 'y': box[1], 'w': image.size[0], 'h': image.size[1]}
        f['sourceSize'] = {'w': size[0], 'h': size[1]}

    png = os.path.join(OUT, 'peep.png')
    sheet.save(png)
    optimise(png)
    with open(os.path.join(OUT, 'peep.json'), 'w') as out:
        json.dump({
            'frames': frames,
            'meta': {
                'app': 'tools/bake-peep-atlas.py',
                'version': '1.0',
                'image': 'peep.png',
                'format': 'RGBA8888',
                'size': {'w': sw, 'h': sh},
                'scale': '2',
                'texelsPerUnit': TEXELS_PER_UNIT,
                'drop': os.path.basename(os.path.normpath(source)),
            },
        }, out, indent=1)
    print(f'peep.png {sw}x{sh}, {len(frames)} frames, {os.path.getsize(png) // 1024} KB')


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
