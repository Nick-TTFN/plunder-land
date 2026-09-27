#!/usr/bin/env python3
"""
Bake the steel ground pads into `assets/res/ground.png` + `ground.json`.

The source is one 4x3 art drop (`ground-steel-pointy.png`, not checked in, like
the hex sheet's sources) of pointy-top pads with a short wall under their lower
edges:

    columns  satin, faceted, brushed, patched      (surface)
    rows     clean, worn, chipped                  (edge)

    python3 tools/bake-ground-atlas.py [source-png]

What it produces is a PIXI spritesheet at **scale 2**: every frame is baked at
twice its on-screen size, so the canvas (which renders at devicePixelRatio,
capped at 2) draws it texel for texel on a Retina screen, and PIXI reports it
at half size so nothing on the client scales it by hand.

The part worth reading is the warp. The game draws the ground through a tilted
camera (`TILT` in src/objects/tilt.ts): a regular hex lattice squashed to 0.75
of its height. Each pad's six face vertices are measured from the image and the
face is remapped, in three horizontal bands, onto a regular hexagon exactly one
cell wide squashed by the same `TILT`; the wall under it is resized to a fixed
`WALL` height. Remapping only `y`, band by band, keeps every edge straight. The
face lands exactly on its cell, so neighbours' bevels meet and read as the grid
line, and the wall hangs below where the next row's faces cover it except above
an unknown cell, which is the drop into the void. Every frame is the same size
with the face centre on a whole texel (`frame_geometry`), and the tilt is
rounded so a row is a whole pixel, so every face lands on the same sub-pixel
phase; without both the ground wobbles.

Each frame carries its own `anchor` at the face's centre (the wall makes the
frame taller than the face), which PIXI turns into `texture.defaultAnchor`.
"""
import json
import math
import os
import shutil
import subprocess
import sys

import numpy
from PIL import Image, ImageDraw

DEFAULT_SOURCE = os.path.expanduser(
    '~/.codex/.chatgpt-projects/g-p-6851522c7bbc8191ab349a4bd8e8a3ae/assets/hex_tileset/'
    'ground-steel-pointy.png'
)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'res')

# Must match `Hex.SIZE` (and `HexTerrain.BAKED_FOR`).
HEX_SIZE = 45
RESOLUTION = 2
# The face is one cell wide, flat side to flat side, at `RESOLUTION`.
FACE_W = HEX_SIZE * RESOLUTION
SIDE = FACE_W / math.sqrt(3)
# The camera's vertical squash, derived exactly as `TILT` in
# src/objects/tilt.ts is: about 0.75, rounded so that one row of the tilted
# lattice is a whole number of screen pixels (29). Anything else puts every row
# on a different fraction of a pixel and the ground wobbles. Faces are baked
# already squashed, so the ground draws texel for pixel.
ROW = HEX_SIZE * math.sqrt(3) / 2
TILT = round(ROW * 0.75) / ROW
# Screen height of a slab's wall, as a fraction of the face's width. It must
# stay under the tilted side (SIDE * TILT, 0.43 of the width), or the next
# row's faces stop covering it.
WALL = 0.2
# The warp runs at this multiple of the output and is then filtered down.
SUPERSAMPLE = 4
PADDING = 2

SURFACES = ['satin', 'faceted', 'brushed', 'patched']
EDGES = ['clean', 'worn', 'chipped']
# Within a surface's patch, how often each edge comes up. Repeats are weights.
EDGE_WEIGHTS = {'clean': 4, 'worn': 2, 'chipped': 1}
# The order the client lays the surfaces out along its noise field. Value noise
# is centre-heavy, so the middle two carry most of the map: calm satin and
# faceted ground, with brushed and patched as the rarer patches.
REGION_ORDER = ['brushed', 'satin', 'faceted', 'patched']

# Unknown cells are drawn as this outline only (fog of war, decision #36).
# Neighbours share every edge, so each line is drawn twice: keep it faint.
OUTLINE_RGBA = (104, 122, 168, 80)
OUTLINE_WIDTH = 2.0 * RESOLUTION * 0.75
# The void inside the outline: a shade off the background, as in the mockup.
VOID_RGBA = (18, 26, 42, 150)


def runs(mask):
    out, start = [], None
    for i, value in enumerate(mask):
        if value and start is None:
            start = i
        if not value and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def tile_boxes(alpha):
    """The 4x3 grid, measured: columns from the whole sheet, rows per column."""
    solid = alpha > 40
    cols = [r for r in runs(solid.sum(0) > 3) if r[1] - r[0] > 50]
    assert len(cols) == len(SURFACES), f'found {len(cols)} columns'
    boxes = []
    for x0, x1 in cols:
        rows = [r for r in runs(solid[:, x0:x1].sum(1) > 3) if r[1] - r[0] > 50]
        assert len(rows) == len(EDGES), f'column {x0} has {len(rows)} rows'
        boxes.append([(x0, y0, x1, y1) for y0, y1 in rows])
    return boxes  # [col][row]


def face_rows(rgba, box):
    """Source rows of the face's top, upper-side, lower-side and bottom vertices.

    The face's rim is a bright bevel and the wall under it is dark, so the lower
    vertices are where brightness falls hardest, measured a few pixels in from
    each side (the vertical edges) and down the centre column. The bake prints
    them; rows that disagree across one row of the sheet mean a bad read.
    """
    x0, y0, x1, y1 = box
    a = rgba[:, :, 3]
    lum = rgba[:, :, :3].astype(int).sum(2)

    def first_opaque(x):
        return y0 + int(numpy.argmax(a[y0:y1, x] > 128))

    def rim_end(x, start):
        # The steepest fall in brightness, averaged over five columns so one
        # scuff can't win: the bevel's lit edge straight onto the dark wall.
        column = lum[start:y1, x - 2:x + 3].mean(1)
        drop = column[:-3] - column[3:]
        return start + int(numpy.argmax(drop)) + 2

    cx = (x0 + x1) // 2
    top = first_opaque(cx)
    sides = []
    for x in (x0 + 5, x1 - 6):
        upper = first_opaque(x)
        # Search for the lower vertex below the edge's midpoint only: above it
        # everything is face.
        lower = rim_end(x, upper + 10)
        sides.append((upper, lower))
    upper = sum(s[0] for s in sides) / 2
    lower = sum(s[1] for s in sides) / 2
    bottom = rim_end(cx, int(lower))
    return top, upper, lower, bottom


def frame_geometry():
    """Every frame's size and face-centre row, in texels, shared by all.

    The face centre sits on a whole texel row, and the frame is the same size
    for every pad, so the anchor puts every face on the same sub-pixel phase:
    neighbours' bevels meet identically all over the ground.
    """
    half = SIDE * TILT
    centre = math.ceil(half) + 1
    height = math.ceil(centre + half + WALL * FACE_W) + 2
    return centre, height


def warp(image, box, rows):
    """Remap one pad onto a regular hexagon one cell wide, face centre known."""
    x0, y0, x1, y1 = box
    top, upper, lower, bottom = rows
    k = SUPERSAMPLE
    # Destination rows of the same vertices: a regular hexagon squashed by the
    # tilt, then the wall at its own fixed height.
    centre, frame_h = frame_geometry()
    off = centre - SIDE * TILT
    targets = [off + t for t in (0, SIDE / 2 * TILT, SIDE * 1.5 * TILT, SIDE * 2 * TILT)]
    sources = [top, upper, lower, bottom]
    sources.append(y1)
    targets.append(targets[3] + WALL * FACE_W)

    width = FACE_W * k
    height = frame_h * k
    # Anything above the top vertex (the anti-aliased tip) goes with band one.
    sources[0] = y0
    targets[0] = off - (top - y0) * ((targets[1] - off) / (upper - top))

    mesh = []
    for i in range(len(sources) - 1):
        d0 = round(targets[i] * k)
        d1 = round(targets[i + 1] * k)
        if d1 <= d0:
            continue
        s0, s1 = sources[i], sources[i + 1]
        # Quad corners in source: NW, SW, SE, NE.
        quad = (x0, s0, x0, s1, x1, s1, x1, s0)
        mesh.append(((0, max(0, d0), width, d1), quad))

    premultiplied = image.convert('RGBa')
    big = premultiplied.transform((width, height), Image.MESH, mesh, Image.BICUBIC)
    small = big.resize((FACE_W, frame_h), Image.LANCZOS)
    # A pixel of air each side, so filtering never smears into a neighbour.
    framed = Image.new('RGBa', (FACE_W + 2, frame_h))
    framed.paste(small, (1, 0))
    return framed.convert('RGBA'), {'x': 0.5, 'y': centre / frame_h}


def outline():
    """The unknown cell: a thin regular-hexagon stroke on nothing."""
    k = SUPERSAMPLE
    centre, frame_h = frame_geometry()
    w, h = (FACE_W + 2) * k, frame_h * k
    image = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    cx, cy = w / 2, centre * k
    # Pulled in by half the stroke, so the stroke's outer edge is the cell's.
    radius = SIDE * k - OUTLINE_WIDTH * k / 2 / math.cos(math.pi / 6)
    points = [
        (cx + radius * math.cos(math.radians(a)), cy + radius * TILT * math.sin(math.radians(a)))
        for a in (-90, -30, 30, 90, 150, 210)
    ]
    draw = ImageDraw.Draw(image)
    draw.polygon(points, fill=VOID_RGBA)
    draw.line(points + points[:2], fill=OUTLINE_RGBA, width=round(OUTLINE_WIDTH * k), joint='curve')
    small = image.convert('RGBa').resize((w // k, h // k), Image.LANCZOS).convert('RGBA')
    return small, {'x': 0.5, 'y': centre / frame_h}


def clean_alpha(image):
    """The art drop's background is alpha 1-4 noise, not zero; zero it."""
    rgba = numpy.array(image)
    rgba[rgba[:, :, 3] < 24] = 0
    return Image.fromarray(rgba, 'RGBA')


def bake():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    image = clean_alpha(Image.open(source).convert('RGBA'))
    rgba = numpy.array(image)
    boxes = tile_boxes(rgba[:, :, 3])

    # Every pad was drawn to one template, so each vertex's offset below the
    # tile's own top vertex is taken as the median over all twelve. A single
    # tile's read is not trustworthy: a rim chip on a vertex (the chipped row
    # has them on purpose) makes a steeper drop than the wall does.
    measured = {(c, r): face_rows(rgba, boxes[c][r])
                for c in range(len(SURFACES)) for r in range(len(EDGES))}
    offsets = [
        float(numpy.median([rows[i] - rows[0] for rows in measured.values()]))
        for i in range(4)
    ]
    # The bottom vertex is the worst read of the four (the chipped row has a
    # chip right on it), and a vertically squashed regular hexagon has its lower
    # band exactly as tall as its upper one, so take it from those instead.
    offsets[3] = offsets[2] + offsets[1]
    print(f'face vertex offsets below the top vertex: {[round(o) for o in offsets]}')

    tiles, anchors = {}, {}
    for c, surface in enumerate(SURFACES):
        for r, edge in enumerate(EDGES):
            name = f'ground/{surface}_{edge}.png'
            top = measured[(c, r)][0]
            rows = [top + o for o in offsets]
            tiles[name], anchors[name] = warp(image, boxes[c][r], rows)
            print(f'{name:28} read {[round(v - top) for v in measured[(c, r)]]}  '
                  f'-> {tiles[name].size}')
    tiles['ground/outline.png'], anchors['ground/outline.png'] = outline()

    frames, size = pack(tiles)
    for name, anchor in anchors.items():
        frames[name]['anchor'] = anchor

    sheet = Image.new('RGBA', size, (0, 0, 0, 0))
    for name, tile in tiles.items():
        sheet.paste(tile, (frames[name]['frame']['x'], frames[name]['frame']['y']))
    png = os.path.join(OUT, 'ground.png')
    sheet.save(png, optimize=True)
    optimise(png)

    animations = {
        f'ground/{surface}': [
            f'ground/{surface}_{edge}.png'
            for edge in EDGES for _ in range(EDGE_WEIGHTS[edge])
        ]
        for surface in SURFACES
    }
    with open(os.path.join(OUT, 'ground.json'), 'w') as handle:
        json.dump({
            'frames': frames,
            'animations': animations,
            'meta': {
                'app': 'tools/bake-ground-atlas.py',
                'version': '1.0',
                'image': 'ground.png',
                'format': 'RGBA8888',
                'size': {'w': size[0], 'h': size[1]},
                # PIXI divides every frame by this, so a pad is one cell wide
                # on screen and twice that in texels.
                'scale': str(RESOLUTION),
                'hexSize': HEX_SIZE,
                'tilt': TILT,
                'regions': {'ground/steel': [f'ground/{s}' for s in REGION_ORDER]},
                'outline': 'ground/outline.png',
            },
        }, handle, separators=(',', ':'))
        handle.write('\n')

    print(f'{len(tiles)} frames, {size[0]}x{size[1]}, {os.path.getsize(png) // 1024} KB')


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


def pack(tiles, width=512):
    """Shelf packing, tallest first."""
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
    return frames, (width, y + shelf)


if __name__ == '__main__':
    bake()
