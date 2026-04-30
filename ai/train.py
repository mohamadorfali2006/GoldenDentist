"""Train the GoldenDentist U-Net on the Aariz / CEPHA29 dataset.

Usage:
    python ai/train.py --data path/to/Aariz --epochs 80 --batch 4

Aariz ships with pre-defined train/valid/test splits; this script
honors them. Validation MRE is reported in millimetres (using each
image's pixel size from cephalogram_machine_mappings.csv) so the
result is directly comparable to the published Aariz benchmarks. Best
checkpoint by val MRE is saved as ``ai/checkpoints/best.pt``. Run
``ai/export_onnx.py`` afterwards.
"""
from __future__ import annotations

import sys
# Force UTF-8 stdout/stderr so non-ASCII characters print on Windows
# consoles whose default code page is cp1256 / cp1252.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import argparse
import math
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader
from tqdm import tqdm

from dataset import AarizDataset
from landmarks_mapping import OUR_LANDMARK_ORDER
from model import UNet


def heatmap_to_coords(hm: torch.Tensor) -> torch.Tensor:
    """Argmax + sub-pixel parabolic refinement on a [B, K, H, W] heatmap.
    Returns [B, K, 2] (x, y)."""
    b, k, h, w = hm.shape
    flat = hm.view(b, k, -1)
    _, idx = flat.max(dim=-1)
    ys = (idx // w).float()
    xs = (idx % w).float()
    for bi in range(b):
        for ki in range(k):
            cx, cy = int(xs[bi, ki].item()), int(ys[bi, ki].item())
            if 0 < cx < w - 1 and 0 < cy < h - 1:
                c = hm[bi, ki, cy, cx].item()
                xm = hm[bi, ki, cy, cx - 1].item()
                xp = hm[bi, ki, cy, cx + 1].item()
                ym = hm[bi, ki, cy - 1, cx].item()
                yp = hm[bi, ki, cy + 1, cx].item()
                dx = (xm - xp) / (2 * (xm - 2 * c + xp + 1e-6))
                dy = (ym - yp) / (2 * (ym - 2 * c + yp + 1e-6))
                xs[bi, ki] += max(-1.0, min(1.0, dx))
                ys[bi, ki] += max(-1.0, min(1.0, dy))
    return torch.stack([xs, ys], dim=-1)


def per_landmark_radial_errors(
    pred: torch.Tensor, gt: torch.Tensor, mm_per_px: torch.Tensor | None = None,
) -> np.ndarray:
    """Per-landmark radial errors for a single batch.

    Returns array of shape [B, K] in mm if `mm_per_px` is provided,
    otherwise in pixels.
    """
    diffs = (pred - gt).pow(2).sum(-1).sqrt()  # [B, K] in resized pixels
    if mm_per_px is not None:
        diffs = diffs * mm_per_px[:, None]
    return diffs.numpy()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="Aariz dataset root containing train/valid/test")
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--size", type=int, nargs=2, default=[640, 800])
    ap.add_argument("--sigma", type=float, default=3.0)
    ap.add_argument("--ckpt-dir", default=str(Path(__file__).parent / "checkpoints"))
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument(
        "--amp", action="store_true",
        help="Enable mixed-precision (fp16) training. Saves VRAM and "
        "is ~30%% faster on Ampere/Ada GPUs. Recommended on RTX 30/40 series.",
    )
    ap.add_argument(
        "--pos-weight", type=float, default=200.0,
        help="Multiplier for positive (peak) pixels in the heatmap MSE loss. "
        "0 = vanilla MSE (collapses to all-zero predictions due to extreme "
        "class imbalance). 100-300 typically works well. Default: 200.",
    )
    args = ap.parse_args()

    Path(args.ckpt_dir).mkdir(parents=True, exist_ok=True)
    print(f"Device: {args.device}")

    train_ds = AarizDataset(args.data, mode="TRAIN", size=tuple(args.size), sigma=args.sigma, augment=True)
    val_ds   = AarizDataset(args.data, mode="VALID", size=tuple(args.size), sigma=args.sigma, augment=False)
    print(f"Train: {len(train_ds)}  |  Valid: {len(val_ds)}")

    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True,  num_workers=args.workers, pin_memory=True)
    val_dl   = DataLoader(val_ds,   batch_size=args.batch, shuffle=False, num_workers=args.workers, pin_memory=True)

    model = UNet(num_landmarks=len(OUR_LANDMARK_ORDER)).to(args.device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    # Weighted MSE for heat-map regression. With Gaussian sigma=3 only ~0.1%
    # of pixels carry useful signal, so plain MSE collapses to "predict zero
    # everywhere". Weighting positive pixels by `pos_weight` makes them
    # account for ~50% of total loss mass, which forces the network to
    # actually localize the peaks.
    pos_weight = float(args.pos_weight)

    def loss_fn(pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        weight = 1.0 + pos_weight * target  # background=1, peak=1+pos_weight
        return ((pred - target).pow(2) * weight).mean()

    use_amp = bool(args.amp) and args.device.startswith("cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    if use_amp:
        print("Mixed-precision (AMP) training: ENABLED")

    best = math.inf
    for epoch in range(args.epochs):
        # ---- train ----------------------------------------------------
        model.train()
        running = 0.0
        pbar = tqdm(train_dl, desc=f"epoch {epoch+1}/{args.epochs}")
        for img, hm, _, _ in pbar:
            img = img.to(args.device, non_blocking=True)
            hm = hm.to(args.device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=use_amp):
                pred = model(img)
                loss = loss_fn(pred, hm)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            running += loss.item() * img.size(0)
            pbar.set_postfix(loss=loss.item())
        sched.step()
        train_loss = running / len(train_ds)

        # ---- validation ----------------------------------------------
        model.eval()
        all_errs: list[np.ndarray] = []
        with torch.no_grad():
            for img, _, coords, meta in val_dl:
                img = img.to(args.device)
                with torch.amp.autocast("cuda", enabled=use_amp):
                    pred = model(img).float().cpu()
                pred_xy = heatmap_to_coords(pred)
                mm_per_px = torch.as_tensor(
                    meta["mm_per_resized_px"], dtype=torch.float32
                )
                if (mm_per_px > 0).all():
                    errs = per_landmark_radial_errors(pred_xy, coords, mm_per_px)
                    unit = "mm"
                else:
                    errs = per_landmark_radial_errors(pred_xy, coords, None)
                    unit = "px"
                all_errs.append(errs)

        all_errs_cat = np.concatenate(all_errs, axis=0)  # [N, K]
        per_lm = np.nanmean(all_errs_cat, axis=0)        # [K]
        mre = float(np.nanmean(per_lm))

        # SDR — Success Detection Rate at clinical thresholds (mm only).
        if unit == "mm":
            sdr_thresholds = (2.0, 2.5, 3.0, 4.0)
            sdr = {t: float(np.mean(all_errs_cat <= t) * 100) for t in sdr_thresholds}
        else:
            sdr = {}

        print(
            f"epoch {epoch+1}: train_loss={train_loss:.4f}  "
            f"val MRE = {mre:.3f} {unit}"
            + (
                "  SDR%@(2,2.5,3,4)mm = "
                + ", ".join(f"{sdr[t]:.1f}" for t in (2.0, 2.5, 3.0, 4.0))
                if sdr else ""
            )
        )
        for name, e in zip(OUR_LANDMARK_ORDER, per_lm):
            print(f"    {name:5s} {e:6.3f} {unit}")

        ckpt = Path(args.ckpt_dir) / f"epoch_{epoch+1:03d}.pt"
        torch.save({"model": model.state_dict(), "mre": mre, "unit": unit, "epoch": epoch + 1}, ckpt)
        if mre < best:
            best = mre
            torch.save(
                {"model": model.state_dict(), "mre": mre, "unit": unit, "epoch": epoch + 1},
                Path(args.ckpt_dir) / "best.pt",
            )
            print(f"  -> new best MRE {best:.3f} {unit} (saved best.pt)")


if __name__ == "__main__":
    main()
