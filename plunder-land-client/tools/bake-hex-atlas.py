#!/usr/bin/env python3
"""
Bake the hex terrain sheets into `assets/res/hex.png` + `hex.json`.

The two source sheets are 1254x1254 art drops, 6x6 cells each, and are *not*
checked in - they are ~5 MB apiece and the repo is 3.4 MB. Pass the directory
holding them; the default is where the art drop lands.

    python3 tools/bake-hex-atlas.py [source-dir]

What it produces is a PIXI spritesheet in the same hash format as `atlas.json`,
with `animations` groups the client picks from at random. **A group may list the
same frame more than once** - that repetition is the weighting, so plain grass
comes up four times as often as flowers without any weighting code.

Sizing, which is the part worth reading:

  * A pad is baked at exactly the size it is drawn at, for `Hex.SIZE = 45`. The
    game renders at scale 1 with `ROUND_PIXELS`, so a texture baked to size is
    pixel-exact on screen; anything else is a runtime resample of pixel art.
  * `PAD_W x PAD_H` is a regular pointy-top hexagon (`h = w * 2/sqrt(3)`) about
    7% larger than the lattice spacing. The source art is 174x192, which is 4.5%
    short of regular, so the bake corrects the aspect - tiling a short hex leaves
    a transparent notch on every diagonal edge. The 7% is what makes neighbours
    overlap instead of meeting exactly, which is what hides seams once positions
    are rounded to whole pixels.
  * Props are scaled by the same factor that takes a source hex to one cell
    (`HEX_SIZE / 174`), so a tree stays the size the artist drew it relative to
    the ground it stands on. They are cropped to their own alpha bounds and the
    client anchors them bottom-centre.
"""
import json
import os
import shutil
import subprocess
import sys

import numpy
from PIL import Image

DEFAULT_SOURCE = os.path.expanduser(
    '~/.codex/.chatgpt-projects/g-p-6851522c7bbc8191ab349a4bd8e8a3ae/assets/hex_tileset'
)
TERRAIN = 'base-terrain-pixel-art-clean-alpha.png'
OVERLAYS = 'environment-overlays-pixel-art-clean-alpha.png'

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'res')

# The world-unit cell spacing the art is baked for. Must match `Hex.SIZE`; the
# client divides by it to rescale if the two ever disagree.
HEX_SIZE = 45
# How far a pad oversteps its cell, so neighbours overlap rather than abut.
OVERSCALE = 1.07
# Width of one hex in the source sheet, measured from its alpha bounds.
SOURCE_HEX_W = 174

PAD_W = round(HEX_SIZE * OVERSCALE)
PAD_H = round(HEX_SIZE * OVERSCALE * 2 / 3 ** 0.5)
PROP_SCALE = HEX_SIZE / SOURCE_HEX_W

PADDING = 2

# (row, col) into the 6x6 sheet. Repeats are weights.
#
# One group per *region*, not one per plane. Picking a face for each cell out of
# a single palette gives white noise, and a screen of that reads as a chaotic
# checkerboard rather than as ground - the first build looked exactly like that.
# So each plane gets a handful of small palettes and the client chooses between
# them with a noise field, which puts a patch of sand next to a patch of stone
# instead of interleaving every tile with every other.
#
# Each palette is one dominant face plus two relatives, so the variation inside
# a patch stays quiet and the variation between patches is the one you notice.
PAD_GROUPS = {
    'hexpad/grass_bloom': [(0, 0)] * 3 + [(0, 3), (0, 4), (0, 2)],
    'hexpad/grass_meadow': [(0, 0)] * 4 + [(0, 1)] * 2 + [(0, 2)],
    'hexpad/grass_lush': [(0, 1)] * 3 + [(1, 3)] * 2 + [(1, 2)],
    'hexpad/grass_moss': [(1, 0)] * 3 + [(1, 2)] * 2 + [(0, 1)],

    'hexpad/ground_sand': [(2, 1)] * 4 + [(2, 0), (3, 0)],
    'hexpad/ground_dirt': [(2, 0)] * 4 + [(2, 2), (2, 3)],
    'hexpad/ground_earth': [(2, 5)] * 4 + [(2, 3), (2, 0)],
    'hexpad/ground_stone': [(3, 1)] * 3 + [(3, 3)] * 2 + [(3, 0)],
}

# The order the client lays the region palettes out along the noise field, so
# the ones in the middle are the ones it lands on most and the ends are rare.
# Written down rather than left to key order, because "whichever order the JSON
# happened to be in" is not something a renderer should depend on.
PAD_REGIONS = {
    'hexpad/grass': [
        'hexpad/grass_bloom', 'hexpad/grass_meadow',
        'hexpad/grass_lush', 'hexpad/grass_moss',
    ],
    'hexpad/ground': [
        'hexpad/ground_sand', 'hexpad/ground_dirt',
        'hexpad/ground_earth', 'hexpad/ground_stone',
    ],
}

PROP_GROUPS = {
    'hexprop/grass': [
        (1, 0), (1, 1), (1, 2), (1, 3), (1, 4),
        (4, 1), (4, 2), (4, 3), (5, 0), (5, 1),
        (0, 0), (0, 3), (0, 4), (2, 2),
    ],
    'hexprop/ground': [
        (0, 0), (0, 1), (0, 2), (0, 3), (0, 5),
        (2, 0), (2, 1), (2, 2), (2, 3), (2, 4),
        (3, 0), (3, 1), (3, 2), (3, 3), (3, 4), (3, 5),
        (5, 3), (5, 4),
    ],
}


def runs(counts):
    """Contiguous spans of non-zero, used to find the sheet's own grid."""
    out, start = [], None
    for i, value in enumerate(counts):
        if value and start is None:
            start = i
        if not value and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(counts) - 1))
    return out


def merge(spans, limit):
    """Join neighbouring spans that still fit inside one cell.

    One prop has a stray pixel a few rows above its body, which reads as a
    seventh row and makes the grid unrecoverable. Merging on the size of the
    result rather than on the size of the gap is what separates that case from
    the legitimate 6 px gutter between two terrain rows: a stray and its body
    together are 93 px, well under a cell, while two rows together are 392.
    """
    out = []
    for span in spans:
        if out and span[1] - out[-1][0] + 1 <= limit:
            out[-1] = (out[-1][0], span[1])
        else:
            out.append(span)
    return out


def alpha_profile(image, box=None):
    """Per-column and per-row counts of opaque pixels."""
    a = image.split()[3]
    if box is not None:
        a = a.crop(box)
    solid = numpy.array(a) > 16
    return solid.sum(0), solid.sum(1)


def cell_boxes(image, expect=6):
    """The sheet's own 6x6 grid, measured rather than assumed.

    Neither sheet is a clean 209 px grid - both are laid out on a ~201 px pitch
    with their own margins, and a prop can be taller than its nominal cell. So
    the columns are found from the whole sheet's alpha profile (they never
    touch), and each column's rows are found within that column alone.
    """
    cols, _ = alpha_profile(image)
    cell = image.size[0] // expect
    col_runs = merge(runs(cols), cell)
    assert len(col_runs) == expect, f'found {len(col_runs)} columns, expected {expect}'

    boxes = []
    for x0, x1 in col_runs:
        _, rows = alpha_profile(image, (x0, 0, x1 + 1, image.size[1]))
        row_runs = merge(runs(rows), cell)
        assert len(row_runs) == expect, f'column {x0} has {len(row_runs)} rows'
        boxes.append([(x0, y0, x1 + 1, y1 + 1) for y0, y1 in row_runs])

    # boxes[col][row] -> boxes[row][col], to match the (row, col) keys above.
    return [[boxes[c][r] for c in range(expect)] for r in range(expect)]


def bake():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    terrain = Image.open(os.path.join(source, TERRAIN)).convert('RGBA')
    overlays = Image.open(os.path.join(source, OVERLAYS)).convert('RGBA')

    pad_cells = cell_boxes(terrain)
    prop_cells = cell_boxes(overlays)

    tiles = {}

    for cells in PAD_GROUPS.values():
        for row, col in cells:
            name = f'hexpad/pad_{row}{col}.png'
            if name in tiles:
                continue
            # Resized, not cropped-and-resized: the pad is the whole hex and the
            # aspect correction is the point (see the header).
            tiles[name] = terrain.crop(pad_cells[row][col]).resize(
                (PAD_W, PAD_H), Image.LANCZOS
            )

    for cells in PROP_GROUPS.values():
        for row, col in cells:
            name = f'hexprop/prop_{row}{col}.png'
            if name in tiles:
                continue
            crop = overlays.crop(prop_cells[row][col])
            w = max(1, round(crop.size[0] * PROP_SCALE))
            h = max(1, round(crop.size[1] * PROP_SCALE))
            tiles[name] = crop.resize((w, h), Image.LANCZOS)

    frames, size = pack(tiles)

    sheet = Image.new('RGBA', size, (0, 0, 0, 0))
    for name, tile in tiles.items():
        sheet.paste(tile, (frames[name]['frame']['x'], frames[name]['frame']['y']))

    png = os.path.join(OUT, 'hex.png')
    sheet.save(png, optimize=True)
    optimise(png)

    animations = {}
    for group, cells in PAD_GROUPS.items():
        animations[group] = [f'hexpad/pad_{r}{c}.png' for r, c in cells]
    for group, cells in PROP_GROUPS.items():
        animations[group] = [f'hexprop/prop_{r}{c}.png' for r, c in cells]

    # Written compact. It is shipped, not read, and pretty-printing it costs
    # 9 KB against a client whose whole payload is about 1 MB.
    with open(os.path.join(OUT, 'hex.json'), 'w') as handle:
        json.dump({
            'frames': frames,
            'animations': animations,
            'meta': {
                'app': 'tools/bake-hex-atlas.py',
                'version': '1.0',
                'image': 'hex.png',
                'format': 'RGBA8888',
                'size': {'w': size[0], 'h': size[1]},
                'scale': '1',
                'hexSize': HEX_SIZE,
                'regions': PAD_REGIONS,
            },
        }, handle, separators=(',', ':'))
        handle.write('\n')

    print(f'{len(tiles)} frames, {size[0]}x{size[1]}, '
          f'{os.path.getsize(os.path.join(OUT, "hex.png")) // 1024} KB')


def optimise(png):
    """Palette-quantise the sheet if the tools are around.

    Worth the dependency: 193 KB of truecolour becomes 48 KB of 255-colour
    palette with no visible difference, on a client whose whole bundle is about
    1 MB. Skipped rather than fatal when the tools are missing - the sheet is
    correct either way, just larger.
    """
    for command in (
        ['pngquant', '--quality=45-95', '--speed', '1', '--force',
         '--output', png, '255', png],
        ['oxipng', '-o', '4', '--strip', 'safe', '--quiet', png],
    ):
        if shutil.which(command[0]) is None:
            print(f'{command[0]} not installed - shipping an unoptimised sheet')
            continue
        subprocess.run(command, check=True)


def pack(tiles, width=512):
    """Shelf packing, tallest first. Small enough that nothing smarter pays."""
    order = sorted(tiles, key=lambda n: -tiles[n].size[1])
    frames = {}
    x = y = shelf = 0
    for name in order:
        w, h = tiles[name].size
        if x + w + PADDING > width:
            x = 0
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

    height = y + shelf
    return frames, (width, height)


if __name__ == '__main__':
    bake()
