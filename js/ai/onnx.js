// js/ai/onnx.js
// ONNX Runtime Web wrapper for trained cephalometric landmark models.
//
// Convention expected of the ONNX model (keep training pipeline aligned):
//   • Input  : float32 tensor of shape [1, 1, H, W] (single-channel).
//              Pixel values pre-normalized to roughly N(0, 1) using
//              ImageNet-style statistics OR plain (x − 0.5) / 0.5.
//   • Output : float32 tensor of shape [1, K, H', W'] where K = number
//              of landmarks (matching ORDER below). The peak of each
//              channel is the landmark location.
//
// If you train your own model, edit MODEL_INPUT_SIZE / NORMALIZATION /
// LANDMARK_ORDER below to match.
//
// Loading order:
//   1. Try `models/ceph.onnx` (relative to index.html).
//   2. If not found, fall back to the heuristic detector.

// Resolution the model expects.
export const MODEL_INPUT_SIZE = { w: 800, h: 640 };

// Normalization: x_norm = (x/255 − mean) / std
export const NORMALIZATION = { mean: 0.5, std: 0.5 };

// Order of channels in the output tensor (must match the model's training).
// Anything not in this list will be missing from the result.
export const LANDMARK_ORDER = [
  "S", "N", "Or", "Po", "Ar",
  "ANS", "PNS", "A",
  "B", "Pog", "Gn", "Me", "Go",
  "U1", "U1A", "L1", "L1A",
  "OccA", "OccP",
];

let _ortPromise = null;
let _session = null;
let _sessionTried = false;

function loadORT() {
  if (_ortPromise) return _ortPromise;
  _ortPromise = new Promise((resolve, reject) => {
    if (window.ort) return resolve(window.ort);
    const script = document.createElement("script");
    // Pinned CDN for reproducibility.
    script.src = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js";
    script.onload = () => resolve(window.ort);
    script.onerror = (e) => reject(new Error("Failed to load onnxruntime-web from CDN"));
    document.head.appendChild(script);
  });
  return _ortPromise;
}

/** Try to load `models/ceph.onnx`. Returns false if not present. */
export async function tryLoadModel(url = "models/ceph.onnx") {
  if (_session) return true;
  if (_sessionTried) return false;
  _sessionTried = true;
  try {
    const ort = await loadORT();
    // Probe with a HEAD request first to avoid loading 404 HTML as a model.
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) return false;
    _session = await ort.InferenceSession.create(url, {
      executionProviders: ["wasm"], // 'webgpu' if available and model supports it
      graphOptimizationLevel: "all",
    });
    return true;
  } catch (e) {
    console.warn("[ai] No ONNX model loaded; falling back to heuristic.", e?.message);
    _session = null;
    return false;
  }
}

export function isModelLoaded() { return !!_session; }

/**
 * Run trained-model inference on an HTMLImageElement.
 * Returns { points: { [id]: {x, y, confidence} } } in original pixel coords.
 */
export async function detectWithModel(image) {
  if (!_session) throw new Error("ONNX session not initialized");
  const ort = await loadORT();

  const w0 = image.naturalWidth, h0 = image.naturalHeight;
  const W = MODEL_INPUT_SIZE.w, H = MODEL_INPUT_SIZE.h;

  // 1. Resize to model input size on a canvas.
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;

  // 2. Build float32 [1, 1, H, W] tensor with grayscale + normalization.
  const input = new Float32Array(W * H);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const g = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) / 255;
    input[j] = (g - NORMALIZATION.mean) / NORMALIZATION.std;
  }
  const tensor = new ort.Tensor("float32", input, [1, 1, H, W]);

  // 3. Run inference.
  const inputName = _session.inputNames[0];
  const outputs = await _session.run({ [inputName]: tensor });
  const outName = _session.outputNames[0];
  const heat = outputs[outName];
  const [, K, hH, hW] = heat.dims;
  const arr = heat.data;

  // 4. Extract per-channel argmax + sub-pixel parabolic refinement.
  const points = {};
  const sx = w0 / hW, sy = h0 / hH;
  for (let k = 0; k < K && k < LANDMARK_ORDER.length; k++) {
    const offset = k * hW * hH;
    let bestI = 0, bestV = -Infinity;
    for (let i = 0; i < hW * hH; i++) {
      const v = arr[offset + i];
      if (v > bestV) { bestV = v; bestI = i; }
    }
    let cx = bestI % hW;
    let cy = (bestI / hW) | 0;

    // Sub-pixel: parabolic fit on a 3x3 neighborhood.
    if (cx > 0 && cx < hW - 1 && cy > 0 && cy < hH - 1) {
      const c = arr[offset + cy * hW + cx];
      const xm = arr[offset + cy * hW + cx - 1];
      const xp = arr[offset + cy * hW + cx + 1];
      const ym = arr[offset + (cy - 1) * hW + cx];
      const yp = arr[offset + (cy + 1) * hW + cx];
      const dx = (xm - xp) / (2 * (xm - 2 * c + xp + 1e-6));
      const dy = (ym - yp) / (2 * (ym - 2 * c + yp + 1e-6));
      cx += clamp(dx, -1, 1);
      cy += clamp(dy, -1, 1);
    }

    points[LANDMARK_ORDER[k]] = {
      x: cx * sx,
      y: cy * sy,
      // Heatmap peaks for trained heatmaps are roughly in [0, 1]; clamp.
      confidence: clamp(bestV, 0, 1),
      suggested: true,
    };
  }
  return { points };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
