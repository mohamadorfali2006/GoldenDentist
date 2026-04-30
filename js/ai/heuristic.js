// js/ai/heuristic.js
// Atlas-based landmark detector that runs ENTIRELY in the browser
// (no model file, no server, no Python). It is a pragmatic fallback
// for the trained ONNX model:
//
//   1. Detect the bony silhouette of the head (Otsu threshold +
//      largest connected component).
//   2. Estimate the head's bounding box and orientation (face-left or
//      face-right).
//   3. Place each cephalometric landmark at a normalized position
//      derived from a published mean shape (see ATLAS below), mapped
//      back into the original image space.
//   4. Snap selected landmarks (S, N, Pog, Me, Go, ANS) to local image
//      features (darkest cavity for Sella; anterior/posterior contour
//      extremes for the rest) for sub-bbox accuracy.
//
// Reported per-landmark confidences are heuristic — they are the
// snap-distance score for refined landmarks and a fixed mid-confidence
// value for atlas-only ones. The user is expected to verify every
// suggested point. This is by design.

import {
  toGrayscale,
  clahe,
  otsuThreshold,
  threshold,
  largestComponent,
  rowExtents,
  guessOrientation,
  findDarkestNear,
} from "./preprocess.js";

// ---------------------------------------------------------------------
// Mean shape (atlas)
// ---------------------------------------------------------------------
// Coordinates are NORMALIZED to the head bounding box, with x in [0, 1]
// where 1 = the most anterior (face) edge and 0 = the most posterior
// (occiput) edge, regardless of the actual screen orientation. Y is in
// [0, 1] from skull top (0) to mandible bottom (1).
//
// Values are derived from a typical adult Class I lateral ceph and
// rounded to two decimals — they're a starting point, not a diagnosis.

const ATLAS = {
  S:    { x: 0.40, y: 0.18, refine: "darkest", radius: 0.06 },
  N:    { x: 0.92, y: 0.16, refine: "anterior", radius: 0.04 },
  Or:   { x: 0.85, y: 0.30, refine: null,        radius: 0   },
  Po:   { x: 0.30, y: 0.30, refine: null,        radius: 0   },
  Ar:   { x: 0.32, y: 0.45, refine: null,        radius: 0   },

  ANS:  { x: 0.97, y: 0.42, refine: "anterior", radius: 0.04 },
  PNS:  { x: 0.55, y: 0.42, refine: null,        radius: 0   },
  A:    { x: 0.93, y: 0.50, refine: "anterior", radius: 0.03 },

  B:    { x: 0.88, y: 0.74, refine: "anterior", radius: 0.03 },
  Pog:  { x: 0.90, y: 0.86, refine: "anterior", radius: 0.03 },
  Gn:   { x: 0.86, y: 0.92, refine: "anteriorBottom", radius: 0.04 },
  Me:   { x: 0.78, y: 0.96, refine: "bottom",   radius: 0.05 },
  Go:   { x: 0.30, y: 0.80, refine: "posteriorBottom", radius: 0.06 },

  // Dental landmarks — placed inside the dento-alveolar zone.
  U1:   { x: 0.95, y: 0.55, refine: null, radius: 0 },
  U1A:  { x: 0.90, y: 0.48, refine: null, radius: 0 },
  L1:   { x: 0.93, y: 0.62, refine: null, radius: 0 },
  L1A:  { x: 0.88, y: 0.70, refine: null, radius: 0 },

  OccA: { x: 0.92, y: 0.60, refine: null, radius: 0 },
  OccP: { x: 0.40, y: 0.60, refine: null, radius: 0 },
};

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Run heuristic landmark detection on a loaded HTMLImageElement.
 *
 * @param {HTMLImageElement} image
 * @param {Object} [opts]
 * @param {"auto"|"left"|"right"} [opts.orientation="auto"]
 * @returns {{ points: Object<id,{x,y,confidence}>, bbox, orientation, debug }}
 *
 * Returned points are in the **original image's pixel coordinates**
 * (the same coordinate space landmarks are stored in, so they can be
 * fed directly to `tracer.loadPoints`).
 */
export async function detectLandmarks(image, opts = {}) {
  const requestedOri = opts.orientation || "auto";

  // 1. Down-sample + grayscale for fast processing.
  const gray = toGrayscale(image, 1024);

  // 2. Local contrast + Otsu threshold to isolate bone/tissue.
  const enhanced = clahe(gray, 64);
  const t = otsuThreshold(enhanced);
  const mask = threshold(enhanced, t);

  // 3. Pick the largest connected component (the head).
  const { mask: head, bbox } = largestComponent(mask);

  // 4. Orientation detection.
  const orientation = requestedOri === "auto" ? guessOrientation(head, bbox) : requestedOri;

  // 5. Per-row extremes for contour snapping.
  const extents = rowExtents(head, bbox);

  // 6. Map atlas → bbox and refine.
  const downscale = gray.scale; // image-down → original-up factor (<= 1)
  const points = {};
  for (const [id, def] of Object.entries(ATLAS)) {
    // Atlas x is "anterior-relative". Flip if face points left.
    const ax = orientation === "right" ? def.x : 1 - def.x;
    const px = bbox.x + ax * (bbox.w - 1);
    const py = bbox.y + def.y * (bbox.h - 1);

    let refined = { x: px, y: py };
    let confidence = 0.5;

    const radius = def.radius * Math.max(bbox.w, bbox.h);
    switch (def.refine) {
      case "darkest": {
        const r = findDarkestNear(enhanced, px, py, radius);
        refined = { x: r.x, y: r.y };
        confidence = 0.7 - r.value / 510; // darker → more confident
        break;
      }
      case "anterior": {
        // Snap to the anterior contour at the same row.
        const rel = clamp((py - bbox.y) | 0, 0, bbox.h - 1);
        const ext = orientation === "right" ? extents.right[rel] : extents.left[rel];
        if (ext > 0) {
          refined = { x: ext, y: py };
          confidence = 0.65;
        }
        break;
      }
      case "anteriorBottom":
      case "posteriorBottom":
      case "bottom": {
        // Search the bottom band of the bbox for the lowest contour
        // pixel near the predicted x.
        const xTarget = px;
        const yStart = Math.round(bbox.y + 0.85 * (bbox.h - 1));
        let bestY = py, bestX = xTarget;
        for (let y = yStart; y < bbox.y + bbox.h; y++) {
          const rel = y - bbox.y;
          const xs = (def.refine === "posteriorBottom")
            ? [extents.left[rel]]
            : (def.refine === "anteriorBottom")
              ? [extents.right[rel]]
              : [extents.left[rel], extents.right[rel]];
          for (const x of xs) {
            if (x < 0) continue;
            if (Math.abs(x - xTarget) < radius && y > bestY) { bestY = y; bestX = x; }
          }
        }
        refined = { x: bestX, y: bestY };
        confidence = 0.6;
        break;
      }
      default:
        confidence = 0.45;
    }

    // Map back to original image pixel coords.
    const inv = 1 / downscale;
    points[id] = {
      x: refined.x * inv,
      y: refined.y * inv,
      confidence: clamp(confidence, 0, 1),
      suggested: true,
    };
  }

  return {
    points,
    bbox: {
      x: bbox.x / downscale,
      y: bbox.y / downscale,
      w: bbox.w / downscale,
      h: bbox.h / downscale,
    },
    orientation,
    debug: { thresholdValue: t, downscale },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
