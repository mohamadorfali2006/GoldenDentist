"""Smoke-test for the CUDA / PyTorch install.

Prints versions, confirms PyTorch sees the GPU, allocates a tensor on
the device, and runs a tiny forward pass through the U-Net to make sure
training will actually use CUDA.

Exit code 0 on success, 1 on any failure.
"""
from __future__ import annotations

import sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def main() -> int:
    print("--- Python ---")
    print(f"  {sys.version}")

    print("\n--- PyTorch ---")
    try:
        import torch
    except ImportError as e:
        print(f"  FAIL: torch not importable: {e}")
        return 1
    print(f"  torch              {torch.__version__}")
    print(f"  built with CUDA    {torch.version.cuda}")
    print(f"  cudnn              {torch.backends.cudnn.version()}")
    print(f"  cuda available     {torch.cuda.is_available()}")
    if not torch.cuda.is_available():
        print("\n  FAIL: torch.cuda.is_available() is False.")
        print("        Make sure you installed the CUDA wheel:")
        print("          pip install torch --index-url https://download.pytorch.org/whl/cu126")
        return 1
    print(f"  device count       {torch.cuda.device_count()}")
    for i in range(torch.cuda.device_count()):
        p = torch.cuda.get_device_properties(i)
        print(
            f"  device {i}           {p.name} | "
            f"{p.total_memory/1024**3:.1f} GB VRAM | "
            f"compute {p.major}.{p.minor}"
        )

    print("\n--- Tensor allocation on device ---")
    x = torch.randn(2, 1, 640, 800, device="cuda")
    print(f"  x.shape = {tuple(x.shape)}, x.device = {x.device}")

    print("\n--- U-Net forward pass on device ---")
    sys.path.insert(0, str(__file__).rsplit("\\", 1)[0])
    try:
        from model import UNet
    except ImportError:
        from ai.model import UNet
    model = UNet(num_landmarks=19).cuda().eval()
    with torch.no_grad():
        y = model(x)
    print(f"  y.shape = {tuple(y.shape)}, y.device = {y.device}")

    free, total = torch.cuda.mem_get_info()
    print(
        f"\n  VRAM after forward: "
        f"{(total - free) / 1024**3:.2f} GB used / "
        f"{total / 1024**3:.2f} GB total"
    )

    print("\nOK - CUDA works. Ready to train.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
