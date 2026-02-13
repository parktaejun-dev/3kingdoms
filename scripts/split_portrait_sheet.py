#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageStat

OFFICER_PRESET_4X6: dict[tuple[int, int], str | None] = {
    (1, 1): "dong_zhuo",
    (1, 2): "lu_bu",
    (1, 3): "li_ru",
    (1, 4): "hua_xiong",
    (1, 5): "cao_cao",
    (1, 6): "xun_yu",
    (2, 1): "xiahou_dun",
    (2, 2): "xiahou_yuan",
    (2, 3): "zhao_yun",
    (2, 4): "liu_bei",
    (2, 5): "guan_yu",
    (2, 6): None,  # duplicate Guan Yu
    (3, 1): "zhang_fei",
    (3, 2): "sun_jian",
    (3, 3): "huang_gai",
    (3, 4): "cheng_pu",
    (3, 5): "yuan_shao",
    (3, 6): None,  # extra scholar
    (4, 1): "yan_liang",
    (4, 2): "wen_chou",
    (4, 3): "yuan_shu",
    (4, 4): "ji_ling",
    (4, 5): "diaochan",
    (4, 6): "player_default",
}


def is_empty_tile(tile: Image.Image, threshold: float) -> bool:
    gray = tile.convert("L")
    stat = ImageStat.Stat(gray)
    # Near-flat + dark tiles are treated as empty slots.
    return (stat.stddev[0] < threshold) and (stat.mean[0] < 40)


def dhash(tile: Image.Image, size: int = 8) -> int:
    # Difference hash for near-duplicate detection.
    g = tile.convert("L").resize((size + 1, size), Image.Resampling.LANCZOS)
    pixels = list(g.getdata())
    bits = 0
    bit_idx = 0
    for y in range(size):
        row = y * (size + 1)
        for x in range(size):
            left = pixels[row + x]
            right = pixels[row + x + 1]
            if left > right:
                bits |= (1 << bit_idx)
            bit_idx += 1
    return bits


def hamming_distance(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def main() -> int:
    parser = argparse.ArgumentParser(description="Split portrait sheet into per-tile PNG assets.")
    parser.add_argument("input", type=Path, help="input sheet image path")
    parser.add_argument("--out-dir", type=Path, default=Path("_art/portraits"))
    parser.add_argument("--rows", type=int, default=4)
    parser.add_argument("--cols", type=int, default=7)
    parser.add_argument("--margin", type=int, default=12, help="outer margin in pixels")
    parser.add_argument("--gap", type=int, default=14, help="cell gap in pixels")
    parser.add_argument("--prefix", type=str, default="portrait")
    parser.add_argument("--empty-threshold", type=float, default=2.0)
    parser.add_argument("--no-dedupe", action="store_true", help="disable duplicate filtering")
    parser.add_argument("--dedupe-hamming", type=int, default=5, help="max dhash distance to treat as duplicate")
    parser.add_argument(
        "--preset",
        choices=["none", "officers_4x6"],
        default="none",
        help="apply fixed row/col naming and exclusions",
    )
    args = parser.parse_args()

    img = Image.open(args.input).convert("RGBA")
    width, height = img.size

    cell_w = (width - (2 * args.margin) - ((args.cols - 1) * args.gap)) // args.cols
    cell_h = (height - (2 * args.margin) - ((args.rows - 1) * args.gap)) // args.rows

    args.out_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    kept_hashes: list[int] = []
    skipped_empty = 0
    skipped_duplicate = 0
    skipped_by_preset = 0
    used_names: set[str] = set()
    for r in range(args.rows):
        for c in range(args.cols):
            row = r + 1
            col = c + 1
            mapped_name: str | None = None
            if args.preset == "officers_4x6":
                if (row, col) not in OFFICER_PRESET_4X6:
                    skipped_by_preset += 1
                    continue
                mapped_name = OFFICER_PRESET_4X6[(row, col)]
                if mapped_name is None:
                    skipped_by_preset += 1
                    continue
            x = args.margin + c * (cell_w + args.gap)
            y = args.margin + r * (cell_h + args.gap)
            tile = img.crop((x, y, x + cell_w, y + cell_h))
            if is_empty_tile(tile, args.empty_threshold):
                skipped_empty += 1
                continue
            tile_hash = dhash(tile)
            if (not args.no_dedupe) and any(hamming_distance(tile_hash, h) <= args.dedupe_hamming for h in kept_hashes):
                skipped_duplicate += 1
                continue
            if mapped_name:
                filename = mapped_name
            else:
                idx = (r * args.cols) + c + 1
                filename = f"{args.prefix}_{idx:02d}"
            if filename in used_names:
                skipped_by_preset += 1
                continue
            out = args.out_dir / f"{filename}.png"
            tile.save(out)
            kept_hashes.append(tile_hash)
            used_names.add(filename)
            written += 1

    print(f"saved {written} portraits to {args.out_dir}")
    print(f"cell size: {cell_w}x{cell_h}")
    print(f"skipped empty: {skipped_empty}")
    print(f"skipped duplicates: {skipped_duplicate}")
    print(f"skipped preset-filtered: {skipped_by_preset}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
