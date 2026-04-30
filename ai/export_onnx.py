"""Export a trained U-Net checkpoint to a single-file ONNX model for
in-browser inference via onnxruntime-web.

Usage:
    python ai/export_onnx.py --ckpt ai/checkpoints/best.pt --out models/ceph.onnx
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

import onnx
import torch

from model import UNet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", default="models/ceph.onnx")
    ap.add_argument("--landmarks", type=int, default=19)
    ap.add_argument("--size", type=int, nargs=2, default=[640, 800])  # H W (must match front-end)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    model = UNet(num_landmarks=args.landmarks)
    state = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    model.load_state_dict(state["model"] if "model" in state else state)
    model.eval()

    # Use the legacy (non-dynamo) torch.onnx exporter. The dynamo-based one
    # in PyTorch 2.11 splits weights into a sidecar .data file by default,
    # which onnxruntime-web cannot follow when fetching a single URL.
    dummy = torch.zeros(1, 1, args.size[0], args.size[1])
    torch.onnx.export(
        model, dummy, str(out_path),
        input_names=["input"], output_names=["heatmap"],
        opset_version=args.opset,
        dynamic_axes={"input": {0: "batch"}, "heatmap": {0: "batch"}},
        dynamo=False,
    )

    # Belt-and-braces: if any external-data file was somehow produced, fold
    # it into the main model file and delete the sidecar so the front-end
    # only has to fetch one URL.
    sidecar = out_path.with_suffix(out_path.suffix + ".data")
    m = onnx.load(str(out_path), load_external_data=True)
    onnx.save(m, str(out_path), save_as_external_data=False)
    if sidecar.exists():
        sidecar.unlink()
        print(f"  (folded sidecar weights from {sidecar.name})")

    size_mb = out_path.stat().st_size / 1024**2
    onnx.checker.check_model(m)
    print(f"Exported {out_path}  ({size_mb:.1f} MB, single file)")
    if size_mb < 5:
        print("  WARNING: file is suspiciously small. Verify it contains weights.")
    print("Drop this file at  <project>/models/ceph.onnx  and the front-end will pick it up.")


if __name__ == "__main__":
    main()
