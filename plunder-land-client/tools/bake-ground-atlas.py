#!/usr/bin/env python3
"""
Bake the steel ground into `assets/res/ground.png` + `ground.json`.

The sources are an art drop that is not checked in, like the hex sheet's:

    <source-dir>/transparent-top-faces/<surface>-<edge>.png   12 flat top faces
    <source-dir>/manifest.json                                each face's 6 vertices
    <source-dir>/edge-fade.png                                the drop under an edge

    python3 tools/bake-ground-atlas.py [source-dir]

Faces are surface (satin, faceted, brushed, patched) by edge (clean, worn,
chipped), top only, with no walls. The drop into the void is its own sprite,
the edge fade: two walls, one under each lower edge of a pointy-top cell, fading
downward. The bake cuts it at its apex into a left and a right half, so the
client can hang each under exactly the edge whose neighbour below is unknown.

The output is a PIXI spritesheet at **scale 2**: every frame is baked at twice
its on-screen size, so the canvas (which renders at devicePixelRatio, capped at
2) draws it texel for texel on a Retina screen, and PIXI reports it at half
size so nothing on the client scales it by hand.

The part worth reading is the geometry. The ground is drawn through a tilted
camera (`TILT` in src/objects/tilt.ts): a regular hex lattice squashed to about
0.92 of its height. Each face's six vertices come from the manifest and the face
is remapped, in three horizontal bands, onto a regular hexagon exactly one cell
wide squashed by the same `TILT`. Remapping only `y` band by band, and `x`
linearly, keeps every edge straight. The fade is scaled so its top edges land on
the face's lower edges. Every frame's anchor is the cell centre, on a whole
texel, and the tilt is rounded so a row is a whole pixel: every face lands on
the same sub-pixel phase, which is what keeps the ground from wobbling.
"""
import json
import math
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw

DEFAULT_SOURCE = os.path.expanduser(
    '~/.codex/.chatgpt-projects/g-p-6851522c7bbc8191ab349a4bd8e8a3ae/output/hex-arena/pointy-top-tiles-v1'
)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'res')

# Must match `Hex.SIZE` (and `HexTerrain.BAKED_FOR`).
HEX_SIZE = 45
RESOLUTION = 2
# The face is one cell wide, flat side to flat side, at `RESOLUTION`.
FACE_W = HEX_SIZE * RESOLUTION
SIDE = FACE_W / math.sqrt(3)
# The camera's vertical squash, derived exactly as `TILT` in
# src/objects/tilt.ts is: about 0.93 (the art's own proportions), rounded so
# that one row of the tilted lattice is a whole number of screen pixels (36).
ROW = HEX_SIZE * math.sqrt(3) / 2
TILT = round(ROW * 0.93) / ROW
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

# The edge fade's own geometry, in its source image: the lower-left vertex, the
# apex under the cell's bottom vertex, and the lower-right vertex, where its top
# edges run.
FADE_LEFT = (434, 300)
FADE_APEX = (768, 460)
FADE_RIGHT = (1103, 300)

# Unknown cells are drawn as this outline only (fog of war, decision #36).
# Neighbours share every edge, so each line is drawn twice: keep it faint.
OUTLINE_RGBA = (104, 122, 168, 80)
OUTLINE_WIDTH = 2.0 * RESOLUTION * 0.75
# The void inside the outline: a shade off the background, as in the mockup.
VOID_RGBA = (18, 26, 42, 150)


def frame_geometry():
    """Every face frame's size and centre row, in texels, shared by all.

    The centre sits on a whole texel row and every face frame is the same size,
    so the anchor puts every face on the same sub-pixel phase.
    """
    half = SIDE * TILT
    centre = math.ceil(half) + 1
    return centre, 2 * centre


def face(image, vertices):
    """Remap one face onto a regular hexagon one cell wide, squashed by TILT.

    `vertices` are the manifest's, clockwise from the top: top, upper right,
    lower right, bottom, lower left, upper left.
    """
    k = SUPERSAMPLE
    top, upper_r, lower_r, bottom, lower_l, upper_l = vertices
    x0 = (upper_l[0] + lower_l[0]) / 2
    x1 = (upper_r[0] + lower_r[0]) / 2
    rows = [top[1], (upper_l[1] + upper_r[1]) / 2, (lower_l[1] + lower_r[1]) / 2, bottom[1]]

    centre, frame_h = frame_geometry()
    off = centre - SIDE * TILT
    inner = [off + t for t in (0, SIDE / 2 * TILT, SIDE * 1.5 * TILT, SIDE * 2 * TILT)]
    # The anti-aliased margins above the top vertex and below the bottom one
    # ride with the outer bands' scales.
    sources = [0, rows[1], rows[2], image.size[1]]
    targets = [
        inner[0] - rows[0] * (inner[1] - inner[0]) / (rows[1] - rows[0]),
        inner[1], inner[2],
        inner[3] + (image.size[1] - rows[3]) * (inner[3] - inner[2]) / (rows[3] - rows[2]),
    ]
    # x: one texel of air each side, the face's flat sides on 1 and FACE_W + 1.
    width = FACE_W + 2
    sx = (x1 - x0) / FACE_W
    left, right = x0 - sx, x0 + sx * (FACE_W + 1)

    mesh = []
    for i in range(len(sources) - 1):
        d0 = max(0, round(targets[i] * k))
        d1 = min(frame_h * k, round(targets[i + 1] * k))
        if d1 <= d0:
            continue
        # Clip the band's source rows to what lands inside the frame.
        scale = (sources[i + 1] - sources[i]) / (targets[i + 1] - targets[i])
        s0 = sources[i] + (d0 / k - targets[i]) * scale
        s1 = sources[i] + (d1 / k - targets[i]) * scale
        mesh.append(((0, d0, width * k, d1), (left, s0, left, s1, right, s1, right, s0)))

    big = image.convert('RGBa').transform((width * k, frame_h * k), Image.MESH, mesh, Image.BICUBIC)
    small = big.resize((width, frame_h), Image.LANCZOS).convert('RGBA')
    return small, {'x': 0.5, 'y': centre / frame_h}


def fade_halves(image):
    """The edge fade, scaled onto the cell's lower edges and cut at the apex.

    Both halves are anchored at the cell centre, which lands on a whole texel,
    and meet at x = 0, so drawn together they are the whole fade again.
    """
    k = SUPERSAMPLE
    # Source pixels per texel, across and down.
    per_x = (FADE_RIGHT[0] - FADE_LEFT[0]) / FACE_W
    per_y = (FADE_APEX[1] - FADE_LEFT[1]) / (SIDE / 2 * TILT)
    # The cell centre, in the source: above the apex by the lower half-height.
    cx = FADE_APEX[0]
    cy = FADE_APEX[1] - SIDE * TILT * per_y

    # Everything with any alpha, in texels from the centre, rounded outward.
    alpha = image.split()[3].point(lambda a: 255 if a > 2 else 0)
    bx0, by0, bx1, by1 = alpha.getbbox()
    top = math.floor((by0 - cy) / per_y) - 1
    bottom = math.ceil((by1 - cy) / per_y) + 1
    halves = {}
    for name, (tx0, tx1) in {
        'left': (math.floor((bx0 - cx) / per_x) - 1, 0),
        'right': (0, math.ceil((bx1 - cx) / per_x) + 1),
    }.items():
        w, h = tx1 - tx0, bottom - top
        # Output pixel (X, Y) at supersample -> source.
        data = (per_x / k, 0, cx + tx0 * per_x, 0, per_y / k, cy + top * per_y)
        big = image.convert('RGBa').transform((w * k, h * k), Image.AFFINE, data, Image.BICUBIC)
        small = big.resize((w, h), Image.LANCZOS).convert('RGBA')
        halves[f'ground/fade_{name}.png'] = (small, {'x': -tx0 / w, 'y': -top / h})
    return halves


def outline():
    """The unknown cell: a thin hexagon stroke, squashed by TILT, on nothing."""
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


def bake():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    with open(os.path.join(source, 'manifest.json')) as handle:
        manifest = {t['name']: t for t in json.load(handle)['tiles']}

    tiles = {}
    for surface in SURFACES:
        for edge in EDGES:
            key = f'{surface}-{edge}'
            image = Image.open(os.path.join(source, 'transparent-top-faces', f'{key}.png')).convert('RGBA')
            tiles[f'ground/{surface}_{edge}.png'] = face(image, manifest[key]['top_face_vertices_px'])
    tiles.update(fade_halves(Image.open(os.path.join(source, 'edge-fade.png')).convert('RGBA')))
    tiles['ground/outline.png'] = outline()
    for name, (tile, anchor) in tiles.items():
        print(f'{name:28} {tile.size}  anchor ({anchor["x"]:.3f}, {anchor["y"]:.3f})')

    frames, size = pack({name: tile for name, (tile, _) in tiles.items()})
    for name, (_, anchor) in tiles.items():
        frames[name]['anchor'] = anchor

    sheet = Image.new('RGBA', size, (0, 0, 0, 0))
    for name, (tile, _) in tiles.items():
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
                'fade': {'left': 'ground/fade_left.png', 'right': 'ground/fade_right.png'},
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
