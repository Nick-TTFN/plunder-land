#!/usr/bin/env python3
"""
Bake the arena props, effects and icons into `assets/res/arena.png` +
`arena.json`, and the two blasts into `assets/res/blasts.png` + `blasts.json`.

The source is an art drop that is not checked in, like the ground's and the
hex sheet's (`extraction-arena-library-v2`, 2026-09-28):

    <source-dir>/manifest.json    every asset: file, pixelSize, pivot, frames
    <source-dir>/map/*.png        loot tiers, medkit, bomb, portal, extract pad, stone
    <source-dir>/fx/<id>/frame-NN.png   animation frames, all one size per clip
    <source-dir>/ui/skills/*.png  the eight skill icons, 256 px
    <source-dir>/ui/icons/*.png   HUD and inventory icons

    python3 tools/bake-arena-atlas.py [source-dir]

Both sheets are PIXI spritesheets at **scale 2**, like `ground.json`: the drop
is already exported at twice its on-screen (logical) size, so PIXI reports each
frame at its logical size and the client draws it at scale 1. The skill icons
are the exception in the drop (256 px textures for a 34 px HUD slot); they are
resampled here to 68 px, which is 34 on screen at 2x.

Each frame carries the manifest's pivot as its `anchor`, so a sprite made from
it sits on its ground point without the client knowing the number. Animations
are listed by id under `animations`, frames in the drop's order.

The blasts are twelve 256 px frames each, more than the rest of the drop
together, so they get their own sheet and a 2048-wide texture stays within
every GPU's limit.
"""
import json
import os
import shutil
import subprocess
import sys

from PIL import Image

DEFAULT_SOURCE = os.path.expanduser(
    '~/.codex/.chatgpt-projects/g-p-6851522c7bbc8191ab349a4bd8e8a3ae/output/extraction-arena-library-v2'
)
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'res')
PADDING = 2  # the drop asks for at least 2 px between sprites (INTEGRATION.md)

# manifest id -> frame (or animation) name in the sheet. Anything not listed
# is not baked: the enter-screen chrome waits for the robot-preview milestone.
STILLS = {
    'loot-small': 'map/loot_small.png',
    'loot-medium': 'map/loot_medium.png',
    'loot-large': 'map/loot_large.png',
    'medkit': 'map/medkit.png',
    'bomb': 'map/bomb.png',
    'portal': 'map/portal.png',
    'portal-up': 'map/portal_up.png',
    'portal-down': 'map/portal_down.png',
    'extract-pad': 'map/extract_pad.png',
    'stone-wall': 'map/stone_wall.png',
    'hud-heart': 'ui/hud_heart.png',
    'hud-shield': 'ui/hud_shield.png',
    'hud-loot': 'ui/hud_loot.png',
    'item-medkit': 'ui/item_medkit.png',
    'item-bomb': 'ui/item_bomb.png',
    'ice-breath-particle': 'fx/snowflake.png',
}
SKILLS = {
    'skill-dash': 'ui/skill_dash.png',
    'skill-melee': 'ui/skill_melee.png',
    'skill-shoot': 'ui/skill_shoot.png',
    'skill-defend': 'ui/skill_defend.png',
    'skill-stone-wall': 'ui/skill_stone_wall.png',
    'skill-fireball': 'ui/skill_fireball.png',
    'skill-icicle': 'ui/skill_icicle.png',
    'skill-ice-breath': 'ui/skill_ice_breath.png',
}
SKILL_PX = 68
CLIPS = {
    'fireball': 'fx/fireball',
    'icicle': 'fx/icicle',
    'fire-breath-particle': 'fx/flame',
    'muzzle-flash': 'fx/muzzle',
    'defend-shield': 'fx/shield',
}
BLASTS = {
    'explosion-fire': 'fx/blast_fire',
    'explosion-ice': 'fx/blast_ice',
}


def bake():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    manifest = json.load(open(os.path.join(source, 'manifest.json')))
    assets = {a['id']: a for a in manifest['assets']}

    arena, arena_anims = {}, {}
    for key, name in STILLS.items():
        a = assets[key]
        image = Image.open(os.path.join(source, a['file'])).convert('RGBA')
        assert list(image.size) == a['pixelSize'], f'{key}: {image.size} vs manifest {a["pixelSize"]}'
        arena[name] = (image, a['pivot'])
    for key, name in SKILLS.items():
        a = assets[key]
        image = Image.open(os.path.join(source, a['file'])).convert('RGBA')
        arena[name] = (image.resize((SKILL_PX, SKILL_PX), Image.LANCZOS), a['pivot'])
    for key, name in CLIPS.items():
        arena_anims[name] = clip(source, assets[key], name, arena)

    blasts, blast_anims = {}, {}
    for key, name in BLASTS.items():
        blast_anims[name] = clip(source, assets[key], name, blasts)

    write('arena', arena, arena_anims, 1024, {
        'clips': {CLIPS[k]: {'fps': assets[k]['fps'], 'loop': assets[k]['loop']} for k in CLIPS},
    })
    write('blasts', blasts, blast_anims, 2048, {
        'clips': {BLASTS[k]: {'fps': assets[k]['fps'], 'loop': assets[k]['loop']} for k in BLASTS},
    })


def clip(source, asset, name, into):
    """The clip's frames, from the drop's per-frame files, into `into`."""
    names = []
    for i, file in enumerate(asset['files']):
        image = Image.open(os.path.join(source, file)).convert('RGBA')
        assert list(image.size) == asset['frameSize'], f'{file}: {image.size} vs {asset["frameSize"]}'
        frame = f'{name}_{i:02d}.png'
        into[frame] = (image, asset['pivot'])
        names.append(frame)
    assert len(names) == asset['frames'], f'{asset["id"]}: {len(names)} files, manifest says {asset["frames"]}'
    return names


def write(stem, tiles, animations, width, extra):
    frames, (w, h) = pack({n: t[0] for n, t in tiles.items()}, width)
    sheet = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    for name, (image, pivot) in tiles.items():
        f = frames[name]['frame']
        sheet.paste(image, (f['x'], f['y']))
        frames[name]['anchor'] = {'x': pivot[0], 'y': pivot[1]}
    png = os.path.join(OUT, f'{stem}.png')
    sheet.save(png)
    optimise(png)
    with open(os.path.join(OUT, f'{stem}.json'), 'w') as out:
        json.dump({
            'frames': frames,
            'animations': animations,
            'meta': {
                'app': 'tools/bake-arena-atlas.py',
                'version': '1.0',
                'image': f'{stem}.png',
                'format': 'RGBA8888',
                'size': {'w': w, 'h': h},
                'scale': '2',
                **extra,
            },
        }, out, indent=1)
    print(f'{stem}.png {w}x{h}, {len(frames)} frames, {os.path.getsize(png) // 1024} KB')


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
