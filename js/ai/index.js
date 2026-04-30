// js/ai/index.js
// High-level entry point for automatic landmark detection.
// Picks the best available backend at runtime:
//
//   1. Trained ONNX model at `models/ceph.onnx` (if present) — accurate.
//   2. Heuristic atlas-based detector — always works, gives plausible
//      starting positions that the user is expected to verify.

import { detectLandmarks as heuristicDetect } from "./heuristic.js";
import { tryLoadModel, detectWithModel, isModelLoaded } from "./onnx.js";

let _initialized = false;

export async function initAI() {
  if (_initialized) return;
  _initialized = true;
  // Probe for a trained model. The probe is cheap (HEAD request), and
  // failures don't surface as errors — we just stay on the heuristic.
  await tryLoadModel().catch(() => false);
}

export function backendName() {
  return isModelLoaded() ? "ONNX trained model" : "heuristic atlas";
}

/**
 * Detect landmarks for the given image element.
 * Always resolves; on internal error returns an empty point set.
 *
 * @returns {Promise<{ points, backend, orientation?, bbox? }>}
 */
export async function autoDetect(image, opts = {}) {
  await initAI();
  if (isModelLoaded()) {
    try {
      const { points } = await detectWithModel(image);
      return { points, backend: "onnx" };
    } catch (e) {
      console.warn("[ai] ONNX inference failed; falling back to heuristic.", e);
      // fall through
    }
  }
  const result = await heuristicDetect(image, opts);
  return {
    points: result.points,
    backend: "heuristic",
    orientation: result.orientation,
    bbox: result.bbox,
  };
}
