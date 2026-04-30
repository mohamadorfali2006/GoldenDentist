"""Mapping between Aariz / CEPHA29 annotations and the 19 landmarks
GoldenDentist uses in its UI.

Aariz JSON files store landmarks as an *ordered* array; each entry
carries a `symbol` field (e.g. "S", "ANS", "UIT"). We look up by
symbol — never by array index — so the mapping is robust even if a
future Aariz release reorders the array.

Verified against the actual dataset on 2026-04-30. The 29 Aariz
symbols, in the order they appear in train/.../Senior Orthodontists/*.json,
are:

      0  A      A-point
      1  ANS    Anterior Nasal Spine
      2  B      B-point
      3  Me     Menton
      4  N      Nasion
      5  Or     Orbitale
      6  Pog    Pogonion
      7  PNS    Posterior Nasal Spine
      8  Pn     Pronasale
      9  R      Ramus
     10  S      Sella
     11  Ar     Articulare
     12  Co     Condylion
     13  Gn     Gnathion
     14  Go     Gonion
     15  Po     Porion
     16  LPM    Lower 2nd PM Cusp Tip
     17  LIT    Lower Incisor Tip
     18  LMT    Lower Molar Cusp Tip
     19  UPM    Upper 2nd PM Cusp Tip
     20  UIA    Upper Incisor Apex
     21  UIT    Upper Incisor Tip
     22  UMT    Upper Molar Cusp Tip
     23  LIA    Lower Incisor Apex
     24  Li     Labrale inferius
     25  Ls     Labrale superius
     26  N`     Soft Tissue Nasion
     27  Pog`   Soft Tissue Pogonion
     28  Sn     Subnasale
"""
from __future__ import annotations

from typing import Iterable

import numpy as np


# Order produced by the model — MUST match
# js/ai/onnx.js::LANDMARK_ORDER and ai/model.py::LANDMARK_ORDER.
OUR_LANDMARK_ORDER = [
    "S", "N", "Or", "Po", "Ar",
    "ANS", "PNS", "A",
    "B", "Pog", "Gn", "Me", "Go",
    "U1", "U1A", "L1", "L1A",
    "OccA", "OccP",
]
NUM_OUR_LANDMARKS = len(OUR_LANDMARK_ORDER)  # 19


# Map each of our 19 landmarks to the Aariz symbol that matches it.
# `None` means we derive the value from other landmarks (see below).
OUR_TO_AARIZ_SYMBOL: dict[str, str | None] = {
    "S":   "S",
    "N":   "N",
    "Or":  "Or",
    "Po":  "Po",
    "Ar":  "Ar",
    "ANS": "ANS",
    "PNS": "PNS",
    "A":   "A",
    "B":   "B",
    "Pog": "Pog",
    "Gn":  "Gn",
    "Me":  "Me",
    "Go":  "Go",
    "U1":  "UIT",   # Upper Incisor Tip
    "U1A": "UIA",   # Upper Incisor Apex
    "L1":  "LIT",   # Lower Incisor Tip
    "L1A": "LIA",   # Lower Incisor Apex
    "OccA": None,   # derived: mid(U1, L1) — incisor occlusion midpoint
    "OccP": None,   # derived: mid(UMT, LMT) — molar occlusion midpoint
}


def aariz_dict(landmarks: Iterable[dict]) -> dict[str, np.ndarray]:
    """Convert the ``landmarks`` list from an Aariz JSON to a
    {symbol: np.array([x, y])} dict for easy lookup.
    """
    out: dict[str, np.ndarray] = {}
    for lm in landmarks:
        sym = lm["symbol"]
        v = lm["value"]
        out[sym] = np.array([float(v["x"]), float(v["y"])], dtype=np.float32)
    return out


def derive_occlusal(
    coords19: np.ndarray, aariz_by_symbol: dict[str, np.ndarray]
) -> np.ndarray:
    """Fill OccA / OccP. Aariz does not annotate the functional-occlusal-plane
    midpoints directly, but we have everything we need:

    * OccA  = midpoint(U1, L1)         — incisor occlusion midpoint.
    * OccP  = midpoint(UMT, LMT)       — molar occlusion midpoint
                                          (uses Aariz's UMT/LMT).

    If UMT or LMT is missing for some reason we fall back to projecting
    OccA onto the Go-Me line.
    """
    idx = {n: i for i, n in enumerate(OUR_LANDMARK_ORDER)}
    out = coords19.copy()

    U1, L1 = out[idx["U1"]], out[idx["L1"]]
    out[idx["OccA"]] = 0.5 * (U1 + L1)

    UMT = aariz_by_symbol.get("UMT")
    LMT = aariz_by_symbol.get("LMT")
    if UMT is not None and LMT is not None:
        out[idx["OccP"]] = 0.5 * (UMT + LMT)
    else:
        Go, Me = out[idx["Go"]], out[idx["Me"]]
        d = Me - Go
        norm = float(np.linalg.norm(d)) + 1e-9
        u = d / norm
        t = float(np.dot(out[idx["OccA"]] - Go, u))
        foot = Go + t * u
        out[idx["OccP"]] = 0.6 * Go + 0.4 * foot
    return out


def map_aariz_to_ours(landmarks: Iterable[dict]) -> np.ndarray:
    """Convert Aariz's `landmarks` list (29 entries) into our (19, 2) array.

    Looks up each of our 19 by Aariz `symbol`, then computes the two
    derived occlusal points.
    """
    aariz_by_symbol = aariz_dict(landmarks)
    out = np.full((NUM_OUR_LANDMARKS, 2), np.nan, dtype=np.float32)
    for i, name in enumerate(OUR_LANDMARK_ORDER):
        target_sym = OUR_TO_AARIZ_SYMBOL[name]
        if target_sym is None:
            continue
        if target_sym in aariz_by_symbol:
            out[i] = aariz_by_symbol[target_sym]
        else:
            raise KeyError(
                f"Aariz JSON missing symbol {target_sym!r} (needed for our "
                f"{name!r}). Symbols present: {sorted(aariz_by_symbol)}"
            )
    return derive_occlusal(out, aariz_by_symbol)
