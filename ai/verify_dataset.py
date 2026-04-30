"""Visualize Aariz samples to confirm the landmark mapping is correct
BEFORE you spend hours training.

Each output PNG shows:
    * All 29 raw Aariz landmarks labelled with their `symbol` (green).
    * Our 19 mapped landmarks labelled with their name (gold).
    * Derived landmarks (OccA) in pink. OccP is also pink IF UMT/LMT
      were absent and we had to fall back to the geometric estimate;
      otherwise OccP is gold (a real molar midpoint).

Open the resulting PNGs in ``ai/verify_previews/``. If a gold-labelled
dot lands on the wrong anatomy, edit ``OUR_TO_AARIZ_SYMBOL`` in
``landmarks_mapping.py``.

Usage:
    python ai/verify_dataset.py --data path/to/Aariz --n 5 --split TRAIN
"""
from __future__ import annotations

import sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from landmarks_mapping import (
    OUR_LANDMARK_ORDER,
    OUR_TO_AARIZ_SYMBOL,
    aariz_dict,
    map_aariz_to_ours,
)

MODE_DIR = {"TRAIN": "train", "VALID": "valid", "TEST": "test"}


def _avg_landmarks(senior_json: Path, junior_json: Path) -> list[dict]:
    """Average senior + junior annotations by symbol (matches dataset.py)."""
    with open(senior_json, "r", encoding="utf-8") as f:
        senior = json.load(f)["landmarks"]
    with open(junior_json, "r", encoding="utf-8") as f:
        junior = json.load(f)["landmarks"]
    j_by_sym = aariz_dict(junior)
    out: list[dict] = []
    for lm in senior:
        sym = lm["symbol"]
        sx, sy = lm["value"]["x"], lm["value"]["y"]
        if sym in j_by_sym:
            jx, jy = j_by_sym[sym]
            mx, my = 0.5 * (sx + jx), 0.5 * (sy + jy)
        else:
            mx, my = sx, sy
        out.append({"symbol": sym, "value": {"x": float(mx), "y": float(my)}})
    return out


def draw_preview(image_path: Path, senior_json: Path, junior_json: Path, out_path: Path) -> None:
    img = cv2.imread(str(image_path))
    if img is None:
        raise IOError(f"Cannot read {image_path}")

    averaged = _avg_landmarks(senior_json, junior_json)
    by_sym = aariz_dict(averaged)
    coords19 = map_aariz_to_ours(averaged)

    has_molars = ("UMT" in by_sym) and ("LMT" in by_sym)

    # Draw all 29 raw Aariz landmarks (green, with symbol).
    for sym, (x, y) in by_sym.items():
        cv2.circle(img, (int(x), int(y)), 6, (0, 220, 0), -1)
        cv2.putText(
            img, sym, (int(x) + 8, int(y) - 8),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 220, 0), 2,
        )

    # Draw our 19 mapped landmarks (gold for direct, pink for derived/fallback).
    for i, name in enumerate(OUR_LANDMARK_ORDER):
        x, y = coords19[i]
        if np.isnan(x):
            continue
        is_direct = OUR_TO_AARIZ_SYMBOL.get(name) is not None
        if name == "OccP":
            is_direct = has_molars  # pink only if we had to fall back
        color = (0, 215, 215) if is_direct else (180, 105, 255)
        cv2.circle(img, (int(x), int(y)), 11, color, 2)
        cv2.putText(
            img, name, (int(x) + 14, int(y) + 6),
            cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2,
        )

    cv2.imwrite(str(out_path), img)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="Aariz dataset root")
    ap.add_argument("--split", default="TRAIN", choices=["TRAIN", "VALID", "TEST"])
    ap.add_argument("--n", type=int, default=5, help="Number of samples to render")
    ap.add_argument("--out", default=str(Path(__file__).parent / "verify_previews"))
    args = ap.parse_args()

    root = Path(args.data) / MODE_DIR[args.split]
    images_dir = root / "Cephalograms"
    senior_dir = root / "Annotations" / "Cephalometric Landmarks" / "Senior Orthodontists"
    junior_dir = root / "Annotations" / "Cephalometric Landmarks" / "Junior Orthodontists"

    images = sorted(p for p in images_dir.iterdir() if p.is_file())
    if not images:
        raise SystemExit(f"No images in {images_dir}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\nLandmark mapping (our 19 <-- Aariz):")
    for name in OUR_LANDMARK_ORDER:
        sym = OUR_TO_AARIZ_SYMBOL[name]
        print(f"  {name:5s} <-- {sym if sym else '(derived)'}")

    print(f"\nRendering {min(args.n, len(images))} previews into {out_dir} ...")
    for img_path in images[: args.n]:
        stem = img_path.stem
        senior_p = senior_dir / f"{stem}.json"
        junior_p = junior_dir / f"{stem}.json"
        if not (senior_p.exists() and junior_p.exists()):
            print(f"  skip {stem}: missing annotation")
            continue
        out_p = out_dir / f"{stem}_preview.png"
        draw_preview(img_path, senior_p, junior_p, out_p)
        print(f"  wrote {out_p.name}")

    print(
        "\nOpen the previews. Each green-labelled dot is a raw Aariz landmark "
        "(with its symbol). Each gold/pink-labelled dot is one of our 19. "
        "Pink = derived (OccA always; OccP only if UMT/LMT missing).\n\n"
        "If a labelled dot lands on the WRONG anatomical feature, edit "
        "OUR_TO_AARIZ_SYMBOL in landmarks_mapping.py and re-run this script."
    )


if __name__ == "__main__":
    main()
