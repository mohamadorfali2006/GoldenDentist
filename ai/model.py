"""Lightweight U-Net for cephalometric landmark heat-map regression.

This is the production-quality fallback architecture for the GoldenDentist
auto-tracing pipeline.  HRNet-W32 reports ~1.5 mm mean radial error on
ISBI 2015; a U-Net of this depth typically lands around 2.5 mm — good
enough for an "AI suggestion" that the clinician verifies.

Output: a [B, K, H, W] heatmap tensor where K is the number of landmarks.
The model expects single-channel input normalised to N(0, 1).

Train with `train.py`, then export to ONNX with `export_onnx.py` and
drop the resulting `ceph.onnx` into `<project>/models/` so the browser
front-end picks it up automatically.
"""
from __future__ import annotations

import torch
import torch.nn as nn


def conv_block(in_ch: int, out_ch: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(in_ch, out_ch, 3, padding=1, bias=False),
        nn.BatchNorm2d(out_ch),
        nn.ReLU(inplace=True),
        nn.Conv2d(out_ch, out_ch, 3, padding=1, bias=False),
        nn.BatchNorm2d(out_ch),
        nn.ReLU(inplace=True),
    )


class UNet(nn.Module):
    """A standard 4-level U-Net adapted for grayscale input."""

    def __init__(self, num_landmarks: int = 19, base: int = 32) -> None:
        super().__init__()
        self.enc1 = conv_block(1, base)
        self.enc2 = conv_block(base, base * 2)
        self.enc3 = conv_block(base * 2, base * 4)
        self.enc4 = conv_block(base * 4, base * 8)
        self.bottleneck = conv_block(base * 8, base * 16)

        self.up4 = nn.ConvTranspose2d(base * 16, base * 8, 2, stride=2)
        self.dec4 = conv_block(base * 16, base * 8)
        self.up3 = nn.ConvTranspose2d(base * 8, base * 4, 2, stride=2)
        self.dec3 = conv_block(base * 8, base * 4)
        self.up2 = nn.ConvTranspose2d(base * 4, base * 2, 2, stride=2)
        self.dec2 = conv_block(base * 4, base * 2)
        self.up1 = nn.ConvTranspose2d(base * 2, base, 2, stride=2)
        self.dec1 = conv_block(base * 2, base)

        self.head = nn.Conv2d(base, num_landmarks, 1)
        self.pool = nn.MaxPool2d(2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        e1 = self.enc1(x)
        e2 = self.enc2(self.pool(e1))
        e3 = self.enc3(self.pool(e2))
        e4 = self.enc4(self.pool(e3))
        b = self.bottleneck(self.pool(e4))
        d4 = self.dec4(torch.cat([self.up4(b), e4], dim=1))
        d3 = self.dec3(torch.cat([self.up3(d4), e3], dim=1))
        d2 = self.dec2(torch.cat([self.up2(d3), e2], dim=1))
        d1 = self.dec1(torch.cat([self.up1(d2), e1], dim=1))
        # Sigmoid keeps heat-map values in [0, 1] so the front-end can
        # interpret the peak as a confidence score directly.
        return torch.sigmoid(self.head(d1))


# Landmark order MUST match `js/ai/onnx.js::LANDMARK_ORDER`.
LANDMARK_ORDER = [
    "S", "N", "Or", "Po", "Ar",
    "ANS", "PNS", "A",
    "B", "Pog", "Gn", "Me", "Go",
    "U1", "U1A", "L1", "L1A",
    "OccA", "OccP",
]
