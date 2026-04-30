"""End-to-end smoke-test for the exported ONNX model.

Loads `models/ceph.onnx` with ONNX Runtime (the same C++ core that
`onnxruntime-web` is built on, so this catches issues the browser would
hit before they reach the browser), runs inference on a handful of Aariz
validation images, and reports per-landmark error in mm against the
two-rater average ground truth.

Usage:
    python ai/eval_onnx.py
    python ai/eval_onnx.py --model models/ceph.onnx --num 20
"""
from __future__ import annotations

import sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import argparse
from pathlib import Path
from statistics import mean

import cv2
import numpy as np
import onnxruntime as ort

from dataset import (
    NUM_OUR_LANDMARKS,
    _avg_two_raters,
    _read_landmarks_json,
    load_pixel_size_table,
)
from landmarks_mapping import OUR_LANDMARK_ORDER, map_aariz_to_ours

# Must match training / front-end. (W, H)
INPUT_W, INPUT_H = 800, 640

# SDR thresholds in mm (clinical convention: 2/2.5/3/4 mm).
SDR_THRESHOLDS = (2.0, 2.5, 3.0, 4.0)

DEFAULT_DATA = r"C:\Users\PCD\Downloads\Aariz\Aariz"


def preprocess(img_path: Path) -> tuple[np.ndarray, float, float]:
    """Replicate AarizDataset.__getitem__ preprocessing for inference.

    Returns (input_tensor [1, 1, H, W], sx, sy). sx/sy are the scale factors
    from original-resolution pixels to resized-resolution pixels.
    """
    img = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(img_path)
    h0, w0 = img.shape
    sx = INPUT_W / w0
    sy = INPUT_H / h0
    img = cv2.resize(img, (INPUT_W, INPUT_H), interpolation=cv2.INTER_AREA)
    img = img.astype(np.float32) / 255.0
    img = (img - 0.5) / 0.5  # match Normalize(mean=0.5, std=0.5)
    inp = img[None, None]   # [1, 1, H, W]
    return inp, sx, sy


def heatmap_to_xy(heat: np.ndarray) -> np.ndarray:
    """Argmax + 1-pixel quadratic refinement, in resized-pixel coords.

    heat: [K, H, W]
    returns: [K, 2] (x, y)
    """
    k, h, w = heat.shape
    out = np.zeros((k, 2), dtype=np.float32)
    for i in range(k):
        flat = int(heat[i].argmax())
        y, x = divmod(flat, w)

        # Sub-pixel refinement: parabola fit on neighbours, see Newell 2016.
        if 0 < x < w - 1 and 0 < y < h - 1:
            dx = 0.5 * (heat[i, y, x + 1] - heat[i, y, x - 1])
            dy = 0.5 * (heat[i, y + 1, x] - heat[i, y - 1, x])
            out[i, 0] = x + (0.25 if dx > 0 else -0.25)
            out[i, 1] = y + (0.25 if dy > 0 else -0.25)
        else:
            out[i, 0] = x
            out[i, 1] = y
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="models/ceph.onnx")
    ap.add_argument("--data", default=DEFAULT_DATA)
    ap.add_argument("--num", type=int, default=10, help="How many validation images to evaluate.")
    ap.add_argument("--save-overlay", default=None,
                    help="If set, save annotated overlays for the first N images here.")
    args = ap.parse_args()

    model_path = Path(args.model)
    if not model_path.exists():
        print(f"ERROR: {model_path} does not exist. Train and export first.")
        sys.exit(1)
    print(f"Model:   {model_path}  ({model_path.stat().st_size/1024**2:.1f} MB)")

    # Load with ONNX Runtime (CPU is fine; we only do <50 inferences).
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    print(f"  input  '{in_name}' shape {sess.get_inputs()[0].shape}")
    print(f"  output '{out_name}' shape {sess.get_outputs()[0].shape}")

    # Locate validation images and ground-truth annotations directly so we
    # can compare raw pixel coords (the AarizDataset already resizes them).
    data_root = Path(args.data)
    valid = data_root / "valid"
    img_dir = valid / "Cephalograms"
    senior_dir = valid / "Annotations" / "Cephalometric Landmarks" / "Senior Orthodontists"
    junior_dir = valid / "Annotations" / "Cephalometric Landmarks" / "Junior Orthodontists"
    pixel_size = load_pixel_size_table(data_root)

    images = sorted(img_dir.glob("*.png")) + sorted(img_dir.glob("*.jpg"))
    images = images[: args.num]
    if not images:
        print(f"ERROR: no images in {img_dir}")
        sys.exit(1)
    print(f"Evaluating {len(images)} validation images...\n")

    if args.save_overlay:
        Path(args.save_overlay).mkdir(parents=True, exist_ok=True)

    per_lm_errors_mm: list[list[float]] = [[] for _ in range(NUM_OUR_LANDMARKS)]
    overall_mre: list[float] = []
    sdr_hits = {t: 0 for t in SDR_THRESHOLDS}
    sdr_total = 0

    for i, img_p in enumerate(images):
        stem = img_p.stem
        senior = _read_landmarks_json(senior_dir / f"{stem}.json")
        junior = _read_landmarks_json(junior_dir / f"{stem}.json")
        avg = _avg_two_raters(senior, junior)
        gt_native = map_aariz_to_ours(avg)  # [19, 2] in original-res pixels

        inp, sx, sy = preprocess(img_p)
        gt_resized = gt_native.copy()
        gt_resized[:, 0] *= sx
        gt_resized[:, 1] *= sy

        heat = sess.run([out_name], {in_name: inp})[0][0]  # [K, H, W]
        pred = heatmap_to_xy(heat)  # [K, 2] resized-pixel coords

        ps_mm = pixel_size.get(stem, 0.0)
        mm_per_resized_px = ps_mm / (0.5 * (sx + sy)) if ps_mm else 0.0

        diffs_px = np.linalg.norm(pred - gt_resized, axis=1)  # [K]
        diffs_mm = diffs_px * mm_per_resized_px

        peak_max = float(heat.max())
        peak_min_per_channel = heat.reshape(NUM_OUR_LANDMARKS, -1).max(axis=1).min()
        print(f"[{i+1:2d}/{len(images)}] {stem}")
        print(f"  peak max {peak_max:.4f}  per-channel-min {peak_min_per_channel:.4f}")
        print(f"  mean err {np.nanmean(diffs_mm):6.2f} mm  median {np.median(diffs_mm):6.2f} mm")

        for k in range(NUM_OUR_LANDMARKS):
            if not np.isnan(diffs_mm[k]):
                per_lm_errors_mm[k].append(float(diffs_mm[k]))
                overall_mre.append(float(diffs_mm[k]))
                sdr_total += 1
                for t in SDR_THRESHOLDS:
                    if diffs_mm[k] <= t:
                        sdr_hits[t] += 1

        if args.save_overlay:
            img = cv2.imread(str(img_p))
            img = cv2.resize(img, (INPUT_W, INPUT_H))
            for k in range(NUM_OUR_LANDMARKS):
                gx, gy = int(gt_resized[k, 0]), int(gt_resized[k, 1])
                px, py = int(pred[k, 0]), int(pred[k, 1])
                cv2.circle(img, (gx, gy), 8, (0, 215, 215), 2)
                cv2.circle(img, (px, py), 5, (255, 200, 0), -1)
                cv2.line(img, (gx, gy), (px, py), (0, 0, 255), 1)
            cv2.imwrite(str(Path(args.save_overlay) / f"{stem}.png"), img)

    print("\n" + "=" * 60)
    print(f"Overall MRE: {mean(overall_mre):6.2f} mm   (n = {len(overall_mre)})")
    print("\nPer-landmark MRE (mm):")
    for k, errs in enumerate(per_lm_errors_mm):
        if errs:
            print(f"  {OUR_LANDMARK_ORDER[k]:5s} {mean(errs):6.2f} mm   (worst {max(errs):6.2f})")

    print("\nSuccess Detection Rate:")
    for t in SDR_THRESHOLDS:
        pct = 100.0 * sdr_hits[t] / max(sdr_total, 1)
        print(f"  <= {t:.1f} mm  {pct:5.1f}%   ({sdr_hits[t]}/{sdr_total})")

    print("\nReference (Aariz benchmark, full test set):")
    print("  state-of-the-art:  ~1.7 mm MRE,  ~85% SDR @ 2 mm")
    print("  decent baseline:   ~3.0 mm MRE,  ~60% SDR @ 2 mm")


if __name__ == "__main__":
    main()
