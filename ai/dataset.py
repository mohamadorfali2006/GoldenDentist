"""Aariz / CEPHA29 dataset loader for GoldenDentist.

Verified against the Figshare release — folder layout is:

    <root>/
        train/
            Cephalograms/                        *.png / *.jpg
            Annotations/
                Cephalometric Landmarks/
                    Senior Orthodontists/        *.json
                    Junior Orthodontists/        *.json
                CVM Stages/                      *.json   (ignored)
        valid/    (same)
        test/     (same)
        cephalogram_machine_mappings.csv         per-image pixel size (mm/px)

Each image's two annotation JSONs (senior + junior) are averaged,
then mapped to our 19 landmarks via `landmarks_mapping.py`. The CSV
gives us the millimetre/pixel scale per cephalogram so MRE can be
reported in clinically meaningful units.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Tuple

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

try:
    import albumentations as A
    HAS_ALB = True
except ImportError:
    HAS_ALB = False

from landmarks_mapping import (
    NUM_OUR_LANDMARKS,
    OUR_LANDMARK_ORDER,
    aariz_dict,
    map_aariz_to_ours,
)

# Aariz folder names are lowercase.
MODE_DIR = {"TRAIN": "train", "VALID": "valid", "TEST": "test"}


def gaussian_heatmap(h: int, w: int, x: float, y: float, sigma: float) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    return np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2)).astype(np.float32)


def _read_landmarks_json(path: Path) -> list[dict]:
    """Return the raw landmark list from an Aariz JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["landmarks"]


def _avg_two_raters(senior: list[dict], junior: list[dict]) -> list[dict]:
    """Average senior + junior annotations by ``symbol`` (NOT by index —
    different files can technically order their landmarks differently).

    Returns a list of dicts in the senior file's order, with each
    ``value`` replaced by the mean of the two raters.
    """
    junior_by_sym = aariz_dict(junior)
    out: list[dict] = []
    for lm in senior:
        sym = lm["symbol"]
        s_xy = np.array([lm["value"]["x"], lm["value"]["y"]], dtype=np.float32)
        j_xy = junior_by_sym.get(sym, s_xy)  # fallback to senior if missing
        m = 0.5 * (s_xy + j_xy)
        out.append({"symbol": sym, "value": {"x": float(m[0]), "y": float(m[1])}})
    return out


def load_pixel_size_table(root: Path) -> dict[str, float]:
    """Read ``cephalogram_machine_mappings.csv`` if present.
    Returns {cephalogram_id: pixel_size_mm}. Empty dict if missing.
    """
    csv_path = root / "cephalogram_machine_mappings.csv"
    if not csv_path.exists():
        return {}
    table: dict[str, float] = {}
    with open(csv_path, "r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                table[row["cephalogram_id"]] = float(row["pixel_size"])
            except (KeyError, ValueError):
                continue
    return table


class AarizDataset(Dataset):
    """PyTorch Dataset for one split of the Aariz benchmark.

    Each sample yields ``(image_tensor, heatmaps, coords19, meta)`` where
    ``meta["pixel_size_mm"]`` is the original-resolution mm/px and
    ``meta["scale"]`` is the downsample factor applied. Multiply
    pixel-distance MRE by ``pixel_size_mm / scale`` to recover mm.

    Args:
        root:    Path to the dataset root containing train/valid/test.
        mode:    "TRAIN" | "VALID" | "TEST".
        size:    (H, W) network input size.
        sigma:   Gaussian heat-map sigma in resized-pixel units.
        augment: Apply augmentation (default: True for TRAIN only).
    """

    def __init__(
        self,
        root: str | Path,
        mode: str = "TRAIN",
        size: Tuple[int, int] = (640, 800),
        sigma: float = 3.0,
        augment: bool | None = None,
    ) -> None:
        if mode not in MODE_DIR:
            raise ValueError(f"mode must be one of {list(MODE_DIR)}, got {mode!r}")

        self.root = Path(root)
        self.mode = mode
        self.size = size
        self.sigma = sigma
        self.augment = augment if augment is not None else (mode == "TRAIN")

        split_dir = self.root / MODE_DIR[mode]
        self.images_dir = split_dir / "Cephalograms"
        self.senior_dir = split_dir / "Annotations" / "Cephalometric Landmarks" / "Senior Orthodontists"
        self.junior_dir = split_dir / "Annotations" / "Cephalometric Landmarks" / "Junior Orthodontists"

        if not self.images_dir.exists():
            raise FileNotFoundError(f"Missing images directory: {self.images_dir}")
        if not (self.senior_dir.exists() and self.junior_dir.exists()):
            raise FileNotFoundError(
                f"Missing annotations under {split_dir / 'Annotations'}"
            )

        self.images = sorted(p for p in self.images_dir.iterdir() if p.is_file())
        if not self.images:
            raise FileNotFoundError(f"No images in {self.images_dir}")

        self.pixel_size_mm = load_pixel_size_table(self.root)
        if not self.pixel_size_mm:
            print(
                "[dataset] cephalogram_machine_mappings.csv not found — "
                "MRE will be reported in pixels only."
            )

        self.aug = None
        if self.augment and HAS_ALB:
            self.aug = A.Compose([
                A.RandomBrightnessContrast(p=0.5),
                A.GaussNoise(p=0.3),
                A.ShiftScaleRotate(
                    shift_limit=0.05, scale_limit=0.05, rotate_limit=5,
                    p=0.5, border_mode=0,
                ),
                # No HorizontalFlip — flipping reverses anatomy.
            ], keypoint_params=A.KeypointParams(format="xy", remove_invisible=False))
        elif self.augment and not HAS_ALB:
            print("[dataset] albumentations not installed — training without augmentation")

    # ---- API --------------------------------------------------------

    def __len__(self) -> int:
        return len(self.images)

    def __getitem__(self, idx: int):
        img_path = self.images[idx]
        stem = img_path.stem
        senior_path = self.senior_dir / f"{stem}.json"
        junior_path = self.junior_dir / f"{stem}.json"

        # 1. Image (read as grayscale).
        img = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise IOError(f"Failed to read {img_path}")
        h0, w0 = img.shape

        # 2. Annotations: senior + junior averaged by symbol.
        senior = _read_landmarks_json(senior_path)
        junior = _read_landmarks_json(junior_path)
        averaged = _avg_two_raters(senior, junior)

        # 3. Map to our 19 landmarks.
        coords19 = map_aariz_to_ours(averaged)

        # 4. Resize image and rescale coordinates.
        target_h, target_w = self.size
        img = cv2.resize(img, (target_w, target_h), interpolation=cv2.INTER_AREA)
        sx = target_w / w0
        sy = target_h / h0
        coords19[:, 0] *= sx
        coords19[:, 1] *= sy

        # 5. Augmentation (training only).
        np_img = img.astype(np.float32) / 255.0
        if self.aug is not None:
            kp = [(float(x), float(y)) for x, y in coords19]
            out = self.aug(image=np_img, keypoints=kp)
            np_img = out["image"]
            coords19 = np.asarray(out["keypoints"], dtype=np.float32)
            if coords19.shape[0] != NUM_OUR_LANDMARKS:
                pad = np.full(
                    (NUM_OUR_LANDMARKS - coords19.shape[0], 2), -1.0, dtype=np.float32
                )
                coords19 = np.concatenate([coords19, pad], axis=0)[:NUM_OUR_LANDMARKS]

        # 6. Normalize.
        np_img = (np_img - 0.5) / 0.5
        np_img = np_img[None, ...]  # add channel

        # 7. Heatmaps.
        heatmaps = np.zeros((NUM_OUR_LANDMARKS, target_h, target_w), dtype=np.float32)
        for k, (x, y) in enumerate(coords19):
            if 0 <= x < target_w and 0 <= y < target_h and not np.isnan(x):
                heatmaps[k] = gaussian_heatmap(target_h, target_w, x, y, self.sigma)

        # 8. Per-image scale info so train.py can convert pixel-MRE → mm.
        ps_mm = self.pixel_size_mm.get(stem, 0.0)  # original mm per native pixel
        # In the network's resized pixel space, one pixel covers
        # (ps_mm / mean(sx, sy)) mm of physical distance (approx).
        scale_mean = 0.5 * (sx + sy)
        mm_per_resized_px = ps_mm / scale_mean if (ps_mm and scale_mean) else 0.0

        meta = {
            "stem": stem,
            "scale_x": float(sx),
            "scale_y": float(sy),
            "orig_size": (int(w0), int(h0)),
            "pixel_size_mm": float(ps_mm),
            "mm_per_resized_px": float(mm_per_resized_px),
        }
        return (
            torch.from_numpy(np_img),
            torch.from_numpy(heatmaps),
            torch.from_numpy(coords19.astype(np.float32)),
            meta,
        )
