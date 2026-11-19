#!/usr/bin/env python3
"""
Turns the raw AI-generated images in art/raw/ (subject on a white background)
into trimmed, transparent, game-ready PNG sprites in public/assets/.

    python3 -m venv .venv && .venv/bin/pip install pillow numpy scipy
    .venv/bin/python tools/process_art.py

Steps per image:
  1. flood-fill the background from the image border (so white areas *inside*
     the outline, e.g. highlights, are kept),
  2. build a soft alpha edge + remove the white fringe (colour decontamination),
  3. crop to the subject, downscale with premultiplied alpha, save.
"""
import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "art", "raw")
OUT = os.path.join(ROOT, "public", "assets")

# name -> output width in px (2x the on-screen size at zoom 1)
SPRITES = {
    "tree_pine": dict(w=260),
    "tree_oak": dict(w=340),
    "stump": dict(w=120),
    "rock": dict(w=176),
    "bush_berry": dict(w=136),
    "campfire": dict(w=150),
    "wall": dict(w=116),
    "gate": dict(w=128),
    "spikes": dict(w=136),
    "tent": dict(w=200),
}


def cutout(path, tol=30.0, soft=90.0):
    """Returns float RGBA array (0..1, straight alpha), cropped to the subject."""
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))

    # background = near-bg-coloured pixels connected to the image border
    cand = dist < tol
    lab, _ = ndimage.label(cand)
    edge_labels = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    edge_labels = edge_labels[edge_labels != 0]
    bgmask = np.isin(lab, edge_labels)

    # drop tiny specks that are not part of the subject
    fg = ~bgmask
    flab, n = ndimage.label(fg)
    if n > 1:
        sizes = ndimage.sum(fg, flab, index=np.arange(1, n + 1))
        keep = np.zeros(n + 1, dtype=bool)
        keep[1:] = sizes >= max(60, sizes.max() * 0.002)
        fg = keep[flab]
        bgmask = ~fg

    # soft edge: pixels right next to the background get partial alpha
    alpha = np.ones((h, w), dtype=np.float32)
    alpha[bgmask] = 0.0
    near = ndimage.binary_dilation(bgmask, iterations=2) & ~bgmask
    a_soft = np.clip((dist - tol * 0.5) / soft, 0.0, 1.0)
    alpha[near] = np.minimum(alpha[near], a_soft[near])

    # colour decontamination: remove the background colour from blended pixels
    a3 = np.clip(alpha, 1e-3, 1.0)[..., None]
    col = (rgb - (1.0 - a3) * bg) / a3
    col = np.clip(col, 0, 255)

    rgba = np.dstack([col / 255.0, alpha])
    ys, xs = np.where(alpha > 0.02)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return rgba[y0:y1, x0:x1]


def to_image(rgba):
    return Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")


def resize(img, width):
    """High quality downscale using premultiplied alpha (no fringes)."""
    height = max(1, round(img.height * width / img.width))
    pm = img.convert("RGBa").resize((width, height), Image.LANCZOS)
    return pm.convert("RGBA")


def rgb_to_hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    d = mx - mn
    hgt = np.zeros_like(mx)
    m = d > 1e-6
    rc = np.where(m, (mx - r) / np.where(m, d, 1), 0)
    gc = np.where(m, (mx - g) / np.where(m, d, 1), 0)
    bc = np.where(m, (mx - b) / np.where(m, d, 1), 0)
    hgt = np.where(mx == r, bc - gc, np.where(mx == g, 2.0 + rc - bc, 4.0 + gc - rc))
    hgt = (hgt / 6.0) % 1.0
    hgt = np.where(m, hgt, 0)
    s = np.where(mx > 1e-6, d / np.where(mx > 1e-6, mx, 1), 0)
    return hgt, s, mx


def hsv_to_rgb(h, s, v):
    i = np.floor(h * 6.0).astype(int) % 6
    f = h * 6.0 - np.floor(h * 6.0)
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.dstack([r, g, b])


def bush_without_berries(rgba):
    """Recolours the ripe red berries into small unripe green ones."""
    out = rgba.copy()
    h, s, v = rgb_to_hsv(out[..., :3])
    red = ((h < 0.07) | (h > 0.93)) & (s > 0.45) & (v > 0.3)
    red = ndimage.binary_dilation(red, iterations=1)
    # specular highlights on the berries (near-white pixels enclosed by red)
    white = (s < 0.25) & (v > 0.8)
    red |= white & ndimage.binary_dilation(red, iterations=5)
    nh = np.where(red, 0.27, h)
    ns = np.where(red, np.clip(s * 0.75, 0, 1), s)
    nv = np.where(red, np.clip(v * 0.62 + 0.12, 0, 1), v)
    out[..., :3] = hsv_to_rgb(nh, ns, nv)
    return out


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def split_campfire(rgba):
    """
    Splits the lit campfire into
      * a base without fire (stones, logs, burnt-out centre). The stones that
        were hidden behind the flames are rebuilt by mirroring the front arc.
      * the flames alone (same canvas size, so both layers line up). The game
        draws them on top with a little flicker animation.
    Returns (base, flames, lit).
    """
    H, W, _ = rgba.shape
    h, s, v = rgb_to_hsv(rgba[..., :3])
    a = rgba[..., 3]
    yy, xx = np.mgrid[0:H, 0:W]

    def big_parts(mask, min_size):
        lab, n = ndimage.label(mask)
        if n == 0:
            return mask
        sizes = ndimage.sum(mask, lab, index=np.arange(1, n + 1))
        keep = np.zeros(n + 1, dtype=bool)
        keep[1:] = sizes > min_size
        return keep[lab]

    # flames: saturated red/orange/yellow (+ the enclosed pale core) + outline
    flame = (a > 0.5) & (h < 0.18) & (s > 0.66) & (v > 0.84)
    flame = ndimage.binary_fill_holes(ndimage.binary_opening(flame, iterations=2))
    flame = big_parts(flame, 400)
    ring = ndimage.binary_dilation(flame, iterations=11) & ~flame
    region = flame | (ring & (a > 0.2) & (v < 0.42))
    region = ndimage.binary_closing(region, iterations=3) & (a > 0.02)

    # stones of the fire ring
    stone = (a > 0.5) & (s < 0.22) & (v > 0.30) & (v < 0.88) & (yy > H * 0.45)
    stone = big_parts(ndimage.binary_opening(stone, iterations=3), 1500)
    sy, sx = np.where(stone)
    top, bot = sy.min(), sy.max()
    yc, xc = (top + bot) / 2.0, (sx.min() + sx.max()) / 2.0
    a_out, b_out = (sx.max() - sx.min()) / 2.0, (bot - top) / 2.0
    stone_full = ndimage.binary_dilation(stone, iterations=9) & (a > 0.2) & ((s < 0.3) | (v < 0.42)) & ~region
    stone_full = ndimage.binary_closing(stone_full, iterations=2)

    ash = np.array([0x4a, 0x3d, 0x33]) / 255.0
    coal = np.array([0x2b, 0x23, 0x1f]) / 255.0
    white = (a > 0.5) & (s < 0.14) & (v > 0.9)      # enclosed floor of the pit

    def ell(fa, fb):
        return (((xx - xc) / (a_out * fa)) ** 2 + ((yy - yc) / (b_out * fb)) ** 2) <= 1.0

    inner, outer = ell(0.70, 0.50), ell(0.93, 0.90)
    base = rgba.copy()
    base[white, :3] = ash
    wide = ndimage.binary_dilation(region, iterations=4)
    in_pit = wide & inner & ~stone_full
    base[in_pit, :3] = coal
    base[in_pit, 3] = 1.0
    rng = np.random.default_rng(7)
    fleck = ndimage.gaussian_filter(rng.random((H, W)), 6) > 0.512
    base[in_pit & fleck & ndimage.binary_erosion(in_pit, iterations=8), :3] = np.array([0x5a, 0x50, 0x49]) / 255.0
    base[wide & ~inner & ~stone_full, 3] = 0.0
    base[yy < top - 2, 3] = 0.0

    # back arc of the ring = front arc mirrored upwards, behind everything else
    back = np.zeros_like(rgba)
    ys = np.arange(H)
    src_y = np.round(2 * yc - ys).astype(int)
    ok = (src_y >= 0) & (src_y < H) & (ys < yc)
    stone_layer = rgba.copy()
    stone_layer[~stone_full, 3] = 0.0
    back[ys[ok]] = stone_layer[src_y[ok]]
    ab = base[..., 3:4]
    out = np.zeros_like(base)
    out[..., :3] = base[..., :3] * ab + back[..., :3] * (1 - ab)
    out[..., 3] = base[..., 3] + back[..., 3] * (1 - base[..., 3])
    hole = outer & (out[..., 3] < 0.5)
    out[hole, :3] = ash
    out[hole, 3] = 1.0
    # remove thin leftovers of the flame outline
    solid = ndimage.binary_opening(out[..., 3] > 0.5, structure=disk(7))
    out[~solid & (yy < yc), 3] = 0.0

    flames = rgba.copy()
    flames[~region, 3] = 0.0
    lit = rgba.copy()
    lit[white, :3] = ash
    fy, fx = np.where(region)
    print(f"  campfire flame anchor: x={fx.mean() / W:.3f} bottom={fy.max() / H:.3f} top={fy.min() / H:.3f}")
    return out, flames, lit


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, cfg in SPRITES.items():
        src = os.path.join(RAW, name + ".png")
        if not os.path.exists(src):
            print("missing", src)
            continue
        rgba = cutout(src)
        if name == "campfire":
            base, flames, rgba = split_campfire(rgba)
            for suffix, layer in (("_base", base), ("_flame", flames)):
                im = resize(to_image(layer), cfg["w"])
                im.save(os.path.join(OUT, name + suffix + ".png"), optimize=True)
                print(f"{name + suffix:14s} {im.width}x{im.height}")
        img = resize(to_image(rgba), cfg["w"])
        img.save(os.path.join(OUT, name + ".png"), optimize=True)
        print(f"{name:14s} {img.width}x{img.height}")
        if name == "bush_berry":
            img2 = resize(to_image(bush_without_berries(rgba)), cfg["w"])
            img2.save(os.path.join(OUT, "bush_empty.png"), optimize=True)
            print(f"{'bush_empty':14s} {img2.width}x{img2.height}")


if __name__ == "__main__":
    main()
