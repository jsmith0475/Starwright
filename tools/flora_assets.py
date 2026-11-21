#!/usr/bin/env python3
"""Starwright: build the vegetation textures in media/flora/ from public-domain (CC0) scans.

The game ships the small files this script writes; the scans themselves are not in the repository.
Sources (all CC0 1.0, https://ambientcg.com, by Lennart Demes): download the 1K-JPG archive of each asset
and unpack it into <src>/<AssetId>/ :

    LeafSet016 (oak)   LeafSet010 (maple)   LeafSet014 (birch)   LeafSet022 (shrub)   LeafSet019 (conifer boughs)
    Bark001 (furrowed) Bark004 (scaly)      Bark014 (fir)

    python3 tools/flora_assets.py <src> [media/flora]

Writes
    leaves.webp     1024 x 896 RGBA sheet of single cut-out leaves and boughs, every one lying along +x with its
                    stem at the left edge of its cell and centred on the cell's middle line (layout: SHEET below,
                    mirrored in js/render/floratex.js)
    bark_<kind>.jpg, bark_<kind>_n.jpg   512 x 512 tiling bark colour and (OpenGL) normal maps
Needs Pillow and numpy.
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

CELL = 128
# name: (asset, how many, rotate so the tip points right, first cell (col, row) in 128 px cells, cell size in cells)
SHEET = [
    ('oak', 'LeafSet016', 6, -90, (0, 0), (1, 1)),
    ('maple', 'LeafSet010', 4, -90, (6, 0), (1, 1)),
    ('birch', 'LeafSet014', 6, -90, (2, 1), (1, 1)),
    ('shrub', 'LeafSet022', 6, -90, (0, 2), (1, 1)),
    ('bough', 'LeafSet019', 3, 180, (0, 3), (4, 2)),
]
SHEET_W, SHEET_H = 8 * CELL, 7 * CELL
BARK = [('furrowed', 'Bark001'), ('scaly', 'Bark004'), ('fir', 'Bark014')]


def components(mask, min_area):
    """Bounding boxes (x0, y0, x1, y1) of the connected blobs of a boolean mask, largest first."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if seen[y, x]:
            continue
        q = deque([(y, x)])
        seen[y, x] = True
        x0 = x1 = x
        y0 = y1 = y
        n = 0
        while q:
            cy, cx = q.popleft()
            n += 1
            x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if n >= min_area:
            out.append((n, (x0, y0, x1 + 1, y1 + 1)))
    out.sort(reverse=True)
    return [b for _, b in out]


def bleed(rgb, alpha, rounds=24):
    """Spread the colour of covered texels into the transparent ones round them (no dark fringes when filtered)."""
    rgb = rgb.astype(np.float32).copy()
    known = alpha > 24
    for _ in range(rounds):
        if known.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            k = np.roll(known, (dy, dx), (0, 1))
            acc += np.roll(rgb, (dy, dx), (0, 1)) * k[..., None]
            cnt += k
        new = (~known) & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][:, None]
        known = known | new
    if not known.all():
        rgb[~known] = rgb[known].mean(axis=0) if known.any() else 0
    return rgb.clip(0, 255).astype(np.uint8)


def sprites(src, asset, count, rot):
    col = np.asarray(Image.open(os.path.join(src, asset, asset + '_1K-JPG_Color.jpg')).convert('RGB'), np.float32)
    op = np.asarray(Image.open(os.path.join(src, asset, asset + '_1K-JPG_Opacity.jpg')).convert('L'), np.float32)
    boxes = components(op > 128, 1500)[:count]
    boxes.sort(key=lambda b: (round(b[1] / 200), b[0]))          # reading order
    out = []
    for x0, y0, x1, y1 in boxes:
        a = op[y0:y1, x0:x1]
        pm = np.dstack([col[y0:y1, x0:x1] * (a[..., None] / 255), a])       # premultiplied
        im = Image.fromarray(pm.clip(0, 255).astype(np.uint8), 'RGBA')
        if rot:
            im = im.rotate(rot, expand=True, resample=Image.BICUBIC)
        out.append(im)
    return out


def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else 'media/flora'
    os.makedirs(dst, exist_ok=True)
    sheet = np.zeros((SHEET_H, SHEET_W, 4), np.float32)
    for name, asset, count, rot, (c0, r0), (cw, ch) in SHEET:
        got = sprites(src, asset, count, rot)
        if len(got) != count:
            raise SystemExit(f'{asset}: expected {count} cut-outs, found {len(got)}')
        W, H = cw * CELL, ch * CELL
        per_row = 8 // cw
        for i, im in enumerate(got):
            k = min((W - 2) / im.width, (H - 2) / im.height)
            w, h = max(1, round(im.width * k)), max(1, round(im.height * k))
            im = im.resize((w, h), Image.LANCZOS)
            cx, cy = (c0 * CELL + i * W) % SHEET_W, r0 * CELL + ((c0 * CELL + i * W) // SHEET_W) * H
            y = cy + (H - h) // 2
            sheet[y:y + h, cx + 1:cx + 1 + w] = np.asarray(im, np.float32)
        print(f'{name}: {count} from {asset} ({per_row} per row)')
    a = sheet[..., 3]
    rgb = np.where(a[..., None] > 0, sheet[..., :3] * 255 / np.maximum(a[..., None], 1), 0)
    rgb = bleed(rgb, a)
    out = Image.fromarray(np.dstack([rgb, a.clip(0, 255).astype(np.uint8)]), 'RGBA')
    out.save(os.path.join(dst, 'leaves.webp'), quality=88, method=6, exact=True)
    for kind, asset in BARK:
        for suffix, part in (('', 'Color'), ('_n', 'NormalGL')):
            im = Image.open(os.path.join(src, asset, f'{asset}_1K-JPG_{part}.jpg')).convert('RGB').resize((512, 512), Image.LANCZOS)
            im.save(os.path.join(dst, f'bark_{kind}{suffix}.jpg'), quality=84, optimize=True)
    for f in sorted(os.listdir(dst)):
        print(f'  {f}: {os.path.getsize(os.path.join(dst, f)) // 1024} KB')


if __name__ == '__main__':
    main()
