#!/usr/bin/env python3
"""
Bake a robot's rig parts into `assets/res/<robot>.png` + `<robot>.json`
(2026-09-30): Peep (`peep.json`) and Magnet (`magnet.json`, magnet-rig #42).

The source is the v15 rig drop, which is not checked in (like the other art
drops): its finish material maps, a few parts that carry no finish, and the
eye sprites.

    <drop>/materials/neutral|masks|lighting/<art>.png   every finished part
    <drop>/materials/pattern-data/<pattern>/<art>.png    zebra, checker, camo
    <drop>/composed/<art>.png         thigh, shin, blaster (no paint group)
    <drop>/eye/open.png, smile.png    the eye, in the head art's pixels (144 x 198)
    <drop>/eye/visor-reflection.png   over the eye, the head art's size

    python3 tools/bake-peep-atlas.py [drop-dir]             # Peep
    python3 tools/bake-peep-atlas.py magnet [drop-dir]      # Magnet
    python3 tools/bake-peep-atlas.py magnet --lobby         # magnet-lobby.json

`--lobby` bakes the same parts at `LOBBY_DENSITY` times the density into
`<robot>-lobby.png` / `.json`, frames `<robot>-lobby/...`: the lobby draws its
robots up to 5.5x the in-game size, and the game sheet stretched that far is
soft. 2.75x (Nick, 2026-10-01) leaves a texel about two device pixels at the
lobby's largest on a 2x screen, at about 100 KB for both robots; 5.5x, fully
crisp, was about 260 KB. The game keeps its own sheet, drawn texel for pixel.

Every robot is baked at Peep's texels per rig unit, so robots keep their
drawn sizes relative to each other (Magnet's reference pose is 227.9 units
tall to Peep's 245.5).

The drop's images are far larger than the game draws them (the head is 428 px
for about 70 on screen) and each part is a different number of pixels per rig
unit. The rig never reads an image's size: it draws every part into a box in
rig units (`REGIONS` in `src/peep/rig.ts`). So each part is resampled once,
from the full-size art, to its box at `TEXELS_PER_UNIT`, and the client fits
whatever texture it gets into the box. A mismatch here costs sharpness, not
position.

`TEXELS_PER_UNIT` is `RobotSprite`'s display scale times 2: Peep is drawn
`RobotSprite.PEEP_HEIGHT` (53) CSS px tall for the reference pose's 245.5 units, and
the sheet is at **scale 2** like the arena sheets, so a 2x screen gets a texel
per pixel. Change the height there and re-bake here.

**Finishes** (robot-finishes, decision #41). The drop paints a part in its
finish with `composeRGBA` (`materials/compose.mjs`): off the paint mask the
neutral art; on it `clamp(d * (colour * (1 - pa) + pattern * pa) + hi)`, with
`d` twice the lighting map's red, `hi` its green and `pa` the pattern's alpha
times its opacity. The mask says which group (head, body, limbs) a pixel is,
and every part here is one group or none (asserted). So a finished part is
baked as layers the client stacks in this order, all the same frame size:

    peep/<art>/shade.png      grey min(d, 1), tinted by the group's colour
    peep/<art>/<pattern>.png  d * pattern, drawn at the pattern's opacity
    peep/<art>/fixed.png      the neutral art off the mask: outlines, details
    peep/<art>/hi.png         the highlights, drawn additively (`BLEND_MODES.ADD`)

`d` over 1 (up to 1.36 on the torso) is lost, because a tint can't brighten.
Accepted by Nick, 2026-09-30 ("the base shape only has shades for volume").
Otherwise the layers are built so that stacking them at the small size gives
what resampling the drop's composite would (see `layers`), which the self-check
this prints measures. The highlights have to be additive: drawn normally,
`x (1 - hi) + hi`, they came out up to 60/255 too dark, since the drop's
highlights cover most of the paint (median 0.17). Each costs pixi a batch break.
Resampling is Hamming, not the Lanczos the flat parts use: Lanczos rings, and
clipping each layer's ringing separately left 17/255 of error.
`meta.finish` lists each finished part's group and layers, in draw order.

Frames are trimmed of transparent borders (PIXI restores the full size from
`sourceSize`), so centring the sprite on its box still works.
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image

DROPS = os.path.join(os.path.dirname(__file__), '..', 'codex_output')
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'res')
PADDING = 2

# Keep in step with RobotSprite.PEEP_HEIGHT and PEEP_RIG.referenceUnits.
DISPLAY_HEIGHT = 53
REFERENCE_UNITS = 245.5
TEXELS_PER_UNIT = 2 * DISPLAY_HEIGHT / REFERENCE_UNITS
# The lobby sheet's density was chosen as 2.75x the game sheet's when Peep
# was 44 px; the game sheet grew with Peep (53) and the lobby's on-screen size
# didn't, so the factor shrinks to keep the lobby sheets as they were.
LOBBY_DENSITY = 2.75 * 44 / 53

# art -> (file in the drop, box in rig units). The box is the largest any
# region draws that art at (`REGIONS` in src/peep/rig.ts: the thighs are 15
# and 16 wide). The eye's is its 144 x 198 head-art pixels at 178/428 and
# 159/388 units per pixel. `arm_far` is not drawn by any region. A part whose
# paint mask is empty is baked flat from `composed/`; the rest as layers.
PEEP_ARTS = {
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

# `REGIONS` in src/magnet/rig.ts: the thighs are 16 and 17 wide, the shins 15
# and 16, the blaster is drawn at 0.76. Magnet has no hand_far; its far arm
# ends in the magnet.
MAGNET_ARTS = {
    'thigh': ('composed/thigh.png', (17, 29)),
    'shin': ('composed/shin.png', (16, 30)),
    'boot_far': ('composed/boot_far.png', (57, 44)),
    'boot_near': ('composed/boot_near.png', (62, 47)),
    'forearm_far': ('composed/forearm_far.png', (29, 35)),
    'magnet': ('composed/magnet.png', (108, 96)),
    'torso': ('composed/torso.png', (80, 77)),
    'arm_near': ('composed/arm_near.png', (28, 39)),
    'head': ('composed/head.png', (178, 159)),
    'blaster': ('composed/blaster.png', (55 * 0.76, 30 * 0.76)),
    'eye_open': ('eye/open.png', (144 * 178 / 428, 198 * 159 / 388)),
    'eye_smile': ('eye/smile.png', (144 * 178 / 428, 198 * 159 / 388)),
    'visor_reflection': ('eye/visor-reflection.png', (178, 159)),
}

# `REGIONS` in src/periscope/rig.ts. Its eye is Peep's art drawn into a 16 x 29
# box in the sensor's space, and its glint is `reflection`, not a visor.
PERISCOPE_ARTS = {
    'thigh': ('composed/thigh.png', (13, 19)),
    'shin': ('composed/shin.png', (12, 19)),
    'boot_far': ('composed/boot_far.png', (46, 35.5)),
    'boot_near': ('composed/boot_near.png', (50, 38.4)),
    'neck': ('composed/neck.png', (21, 47)),
    'chassis': ('composed/chassis.png', (64, 70)),
    'mount': ('composed/mount.png', (18, 13)),
    'blaster': ('composed/blaster.png', (42, 23)),
    'sensor': ('composed/sensor.png', (105, 54)),
    'eye_open': ('eye/open.png', (16, 29)),
    'eye_smile': ('eye/smile.png', (16, 29)),
    'reflection': ('eye/reflection.png', (3.7, 4.6)),
}

# Drawn bigger than Peep's px per rig unit by this much, so baked denser by it
# too (keep in step with `drawScale` in src/robots/robotrig.ts).
DRAW_SCALE = {'periscope': 1.35}

ROBOTS = {
    'peep': ('peep-animations-v15', PEEP_ARTS),
    'magnet': ('magnet-animations-v2', MAGNET_ARTS),
    'periscope': ('periscope-animations-v1', PERISCOPE_ARTS),
}

PATTERNS = ('zebra', 'checker', 'camo')

# The drop's presets (`finishPresets` in materials/compose.mjs), for the
# self-check only: colour, pattern, opacity per group; limbs copy body. The
# game's table is `src/utils/finishes.ts`.
PRESETS = {
    'mint': {'head': ((239, 233, 212), 'zebra', 1), 'body': ((54, 201, 183), None, 0)},
    'field': {'head': ((225, 202, 154), None, 0), 'body': ((123, 149, 82), 'camo', .45)},
    'wild': {'head': ((239, 233, 212), 'zebra', 1), 'body': ((123, 149, 82), 'camo', .45)},
    'arctic': {'head': ((188, 223, 255), 'zebra', 1), 'body': ((191, 218, 235), 'camo', .45)},
    'sunset': {'head': ((248, 160, 132), 'zebra', 1), 'body': ((225, 155, 105), 'camo', .45)},
    'arcade': {'head': ((239, 233, 225), 'checker', 1), 'body': ((149, 117, 211), 'camo', .45)},
}
for _p in PRESETS.values():
    _p['limbs'] = _p['body']

EPS = 1e-4


def load(source, path):
    """RGBA in 0-1, float."""
    return np.asarray(Image.open(os.path.join(source, path)).convert('RGBA'), dtype=np.float64) / 255


def shrink(channel, size):
    """One channel resampled, clipped back to 0-1. Hamming: no negative lobes, so no ringing."""
    small = Image.fromarray(channel.astype(np.float32), 'F').resize(size, Image.HAMMING)
    return np.clip(np.asarray(small, dtype=np.float64), 0, 1)


def group_of(mask):
    """`surfaceAt` in compose.mjs, per pixel: G wins head, then B limbs, else body."""
    r, g, b = mask[..., 0], mask[..., 1], mask[..., 2]
    return np.where((g > r) & (g >= b), 'head', np.where(b > r, 'limbs', 'body'))


def layers(source, art, size):
    """
    A finished part's layers at `size`, each (rgb, alpha) in 0-1, in draw
    order, plus its group; None if the part has no paint mask.

    Resampled at full size the drop's composite is `fixed + paint`, premultiplied,
    where `fixed` covers F and paint covers W. Drawn over, the layers under
    `fixed` show through (1 - F) of it, so their coverage is W / (1 - F), and
    each carries the paint-weighted average (`avg`) of its quantity.

    The pattern goes over the tinted shade, which subtracts `shade * alpha`.
    The paint wants `c * avg(d * p)` subtracted, not `c * avg(d) * avg(p)`: the
    two differ wherever shading and stripes vary together inside one texel. So
    the pattern's alpha is `avg(d * p) / avg(d)` and its colour makes up the
    rest; neither depends on the colour `c`, and the pattern's opacity scales
    `p`, which scales the alpha alone, so the sprite's alpha can carry it.
    Additive highlights commute with what's under them, so they go last, at
    their plain coverage.
    """
    neutral = load(source, f'materials/neutral/{art}.png')
    mask = load(source, f'materials/masks/{art}.png')
    light = load(source, f'materials/lighting/{art}.png')
    a = neutral[..., 3]
    w = np.minimum(1, mask[..., 0] + mask[..., 1] + mask[..., 2])
    if not (w > 0).any():
        return None
    groups = set(group_of(mask)[w > 0].tolist())
    if len(groups) != 1:
        sys.exit(f'{art}: painted in {sorted(groups)}; one sprite can take one tint')
    group = groups.pop()

    d = light[..., 0] * 2
    dc = np.minimum(d, 1)
    aw = a * w
    af = a * (1 - w)
    W = shrink(aw, size)
    F = shrink(af, size)
    under = np.where(W > EPS, np.clip(W / np.maximum(1 - F, 1e-3), 0, 1), 0)
    avg = lambda q: shrink(q * aw, size) / np.maximum(W, EPS)
    grey = lambda v: np.repeat(v[..., None], 3, axis=2)

    shade = avg(dc)
    out = [('shade', grey(np.clip(shade, 0, 1)), under)]
    for pattern in PATTERNS:
        pat = load(source, f'materials/pattern-data/{pattern}/{art}.png')
        p = pat[..., 3]
        if not (p * aw > 0).any():
            continue
        alpha = np.clip(avg(dc * p) / np.maximum(shade, EPS), 0, 1)
        colour = avg(np.clip(d * pat[..., 0], 0, 1) * p) / np.maximum(alpha, EPS)
        out.append((pattern, grey(np.clip(colour, 0, 1)), alpha * under))
    if F.max() > 1 / 255:
        rgb = np.stack([shrink(neutral[..., c] * af, size) for c in range(3)], axis=2) / np.maximum(F, EPS)[..., None]
        out.append(('fixed', np.clip(rgb, 0, 1), F))
    hi = shrink(light[..., 1] * aw, size)
    if hi.max() > 1 / 255:
        out.append(('hi', np.ones(hi.shape + (3,)), hi))
    return group, out


def compose_reference(source, art, size, finish, clamp_d):
    """The drop's `composeRGBA` at full size, premultiplied, resampled: what the layers should add up to."""
    neutral = load(source, f'materials/neutral/{art}.png')
    mask = load(source, f'materials/masks/{art}.png')
    light = load(source, f'materials/lighting/{art}.png')
    a = neutral[..., 3]
    w = np.minimum(1, mask[..., 0] + mask[..., 1] + mask[..., 2])[..., None]
    colour, pattern, opacity = finish[group_of(mask)[w[..., 0] > 0][0]]
    d = light[..., 0:1] * 2
    if clamp_d:
        d = np.minimum(d, 1)
    unlit = np.array(colour, dtype=np.float64) / 255 * np.ones_like(neutral[..., :3])
    if pattern is not None:
        pat = load(source, f'materials/pattern-data/{pattern}/{art}.png')
        pa = pat[..., 3:4] * opacity
        unlit = unlit * (1 - pa) + pat[..., :3] * pa
    painted = np.clip(d * unlit + light[..., 1:2], 0, 1)
    rgb = neutral[..., :3] * (1 - w) + painted * w
    return np.stack([shrink(rgb[..., c] * a, size) for c in range(3)], axis=2), shrink(a, size)


def stack(parts, finish, group):
    """The layers drawn the way the client draws them, premultiplied."""
    colour, pattern, opacity = finish[group]
    rgb = np.zeros(parts[0][1].shape)
    alpha = np.zeros(parts[0][2].shape)
    for name, layer_rgb, layer_a in parts:
        if name == 'shade':
            layer_rgb = layer_rgb * np.array(colour) / 255
        elif name in PATTERNS:
            if name != pattern:
                continue
            layer_a = layer_a * opacity
        if name == 'hi':
            rgb = np.minimum(1, rgb + layer_rgb * layer_a[..., None])
            continue
        rgb = layer_rgb * layer_a[..., None] + rgb * (1 - layer_a[..., None])
        alpha = layer_a + alpha * (1 - layer_a)
    return rgb, alpha


# The self-check's limit on the interior's 99th percentile, 0-255. Measured
# 2026-09-30: 17 (arctic). What is left is the drop's clamp: it clips `d * colour + hi`
# to white pixel by pixel before anything averages it, which a layer that
# doesn't know the colour can't copy; it shows on the brightest colours (the
# cream and bone heads, the ice torso) as slightly brighter highlights.
INTERIOR_P99_LIMIT = 24


def check(source, finished):
    """
    The stacked layers against the drop's own composite, resampled. Interior:
    texels fully covered, where the layers should agree. Outline: the part's
    antialiased edge, where a pattern drawn over a half-covered shade adds up
    to a quarter of its alpha again (the price of patterns being separate
    sprites). Exits if the interior is worse than INTERIOR_P99_LIMIT.
    """
    print('self-check against compose.mjs (d <= 1), premultiplied RGB, 0-255:')
    worst = 0
    for preset, finish in PRESETS.items():
        inner_err, edge_err = [], []
        for art, (group, size, parts) in finished.items():
            got, _ = stack(parts, finish, group)
            want, want_a = compose_reference(source, art, size, finish, True)
            err = np.abs(got - want).max(axis=2) * 255
            under = parts[0][2]
            inner = (want_a > 0.99) & ((under > 0.98) | (under < 0.02))
            inner_err.append(err[inner])
            edge_err.append(err[(want_a > 0.01) & ~inner])
        inner_all = np.concatenate(inner_err)
        edge_all = np.concatenate(edge_err)
        p99 = np.percentile(inner_all, 99)
        worst = max(worst, p99)
        print(f'  {preset:7} interior p99 {p99:5.1f} median {np.median(inner_all):4.1f}'
              f'   outline p99 {np.percentile(edge_all, 99):5.1f} ({len(edge_all)} of {len(edge_all) + len(inner_all)} texels)')
    if worst > INTERIOR_P99_LIMIT:
        sys.exit(f'self-check failed: interior p99 {worst:.1f} > {INTERIOR_P99_LIMIT}')


def to_image(rgb, alpha):
    """Straight RGBA, 8-bit; transparent pixels black."""
    a = np.round(alpha * 255)
    rgb = np.where(a[..., None] > 0, np.round(rgb * 255), 0)
    return Image.fromarray(np.dstack([rgb, a]).astype(np.uint8), 'RGBA')


def bake():
    args = sys.argv[1:]
    lobby = '--lobby' in args
    args = [a for a in args if a != '--lobby']
    robot = args.pop(0) if args and args[0] in ROBOTS else 'peep'
    density = TEXELS_PER_UNIT * (LOBBY_DENSITY if lobby else 1) * DRAW_SCALE.get(robot, 1)
    out_name = f'{robot}-lobby' if lobby else robot
    drop, arts = ROBOTS[robot]
    source = args[0] if args else os.path.join(DROPS, drop)
    tiles = {}
    finished = {}

    def add(name, small, size):
        box = small.getchannel('A').point(lambda a: 255 if a > 2 else 0).getbbox() or (0, 0, 1, 1)
        tiles[name] = (small.crop(box), size, box)

    for art, (file, (w, h)) in arts.items():
        size = (max(1, round(w * density)), max(1, round(h * density)))
        painted = layers(source, art, size) if file.startswith('composed/') else None
        if painted is not None:
            group, parts = painted
            finished[art] = (group, size, parts)
            for name, rgb, alpha in parts:
                add(f'{out_name}/{art}/{name}.png', to_image(rgb, alpha), size)
            continue
        image_full = Image.open(os.path.join(source, file)).convert('RGBA')
        # Premultiplied, so transparent pixels' colour doesn't bleed into edges.
        add(f'{out_name}/{art}.png', image_full.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA'), size)

    check(source, finished)

    frames, (sw, sh) = pack({n: t[0] for n, t in tiles.items()}, 512)
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
                'app': 'tools/bake-peep-atlas.py',
                'version': '1.0',
                'image': f'{out_name}.png',
                'format': 'RGBA8888',
                'size': {'w': sw, 'h': sh},
                'scale': '2',
                'texelsPerUnit': density,
                'drop': os.path.basename(os.path.normpath(source)),
                # Finished part -> its paint group and layers, in draw order.
                'finish': {art: {'group': g, 'layers': [n for n, _, _ in parts]}
                           for art, (g, _, parts) in finished.items()},
            },
        }, out, indent=1)
    print(f'{out_name}.png {sw}x{sh}, {len(frames)} frames, {os.path.getsize(png) // 1024} KB')


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
