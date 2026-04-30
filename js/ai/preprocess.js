// js/ai/preprocess.js
// Image-processing primitives used by both the heuristic detector and
// the ONNX inference pipeline. All operations work on a Uint8 grayscale
// buffer to keep them fast and dependency-free.

/**
 * Render an HTMLImageElement (or any drawable) into an offscreen canvas
 * and return { data, width, height } with `data` a Uint8 grayscale array.
 */
export function toGrayscale(image, maxSide = 1024) {
  const w0 = image.naturalWidth || image.width;
  const h0 = image.naturalHeight || image.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    // ITU-R BT.601 luma coefficients
    gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
  }
  return { data: gray, width: w, height: h, scale };
}

/**
 * CLAHE-like local contrast enhancement implemented as a tiled
 * histogram equalization (no clip-limit redistribution — close enough
 * for our heuristic search). Tile size defaults to 64×64.
 */
export function clahe(img, tile = 64) {
  const { data, width: w, height: h } = img;
  const out = new Uint8Array(data.length);
  const tilesX = Math.max(1, Math.ceil(w / tile));
  const tilesY = Math.max(1, Math.ceil(h / tile));
  // Per-tile lookup tables.
  const luts = new Array(tilesX * tilesY);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tile, y0 = ty * tile;
      const x1 = Math.min(w, x0 + tile), y1 = Math.min(h, y0 + tile);
      const hist = new Uint32Array(256);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) { hist[data[row + x]]++; count++; }
      }
      const lut = new Uint8Array(256);
      let acc = 0;
      for (let i = 0; i < 256; i++) {
        acc += hist[i];
        lut[i] = count ? Math.min(255, (acc * 255 / count) | 0) : i;
      }
      luts[ty * tilesX + tx] = lut;
    }
  }
  // Bilinear blend between tile LUTs to avoid blocky seams.
  for (let y = 0; y < h; y++) {
    const fy = y / tile - 0.5;
    const ty0 = Math.max(0, Math.floor(fy));
    const ty1 = Math.min(tilesY - 1, ty0 + 1);
    const wy = Math.min(1, Math.max(0, fy - ty0));
    for (let x = 0; x < w; x++) {
      const fx = x / tile - 0.5;
      const tx0 = Math.max(0, Math.floor(fx));
      const tx1 = Math.min(tilesX - 1, tx0 + 1);
      const wx = Math.min(1, Math.max(0, fx - tx0));
      const v = data[y * w + x];
      const v00 = luts[ty0 * tilesX + tx0][v];
      const v01 = luts[ty0 * tilesX + tx1][v];
      const v10 = luts[ty1 * tilesX + tx0][v];
      const v11 = luts[ty1 * tilesX + tx1][v];
      const top = v00 * (1 - wx) + v01 * wx;
      const bot = v10 * (1 - wx) + v11 * wx;
      out[y * w + x] = (top * (1 - wy) + bot * wy) | 0;
    }
  }
  return { data: out, width: w, height: h };
}

/** Otsu threshold — returns the optimal cut value in [0, 255]. */
export function otsuThreshold(img) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  const total = img.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, wF = 0, varMax = 0, threshold = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > varMax) { varMax = v; threshold = i; }
  }
  return threshold;
}

/** Threshold to a binary mask (1 = foreground/bone). */
export function threshold(img, t) {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) out[i] = img.data[i] >= t ? 1 : 0;
  return { data: out, width: img.width, height: img.height };
}

/**
 * Connected-components labelling (4-connectivity) on a binary mask.
 * Returns the largest component as a binary mask plus its bounding box.
 */
export function largestComponent(mask) {
  const { data, width: w, height: h } = mask;
  const labels = new Int32Array(data.length);
  let nextLabel = 1;
  // Union-find for label equivalences.
  const parent = [0];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!data[idx]) continue;
      const left = x > 0 ? labels[idx - 1] : 0;
      const up = y > 0 ? labels[idx - w] : 0;
      if (left && up) {
        labels[idx] = Math.min(left, up);
        if (left !== up) union(left, up);
      } else if (left) labels[idx] = left;
      else if (up) labels[idx] = up;
      else { labels[idx] = nextLabel; parent[nextLabel] = nextLabel; nextLabel++; }
    }
  }
  // Resolve labels and count.
  const sizes = new Map();
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const r = find(labels[i]);
    labels[i] = r;
    sizes.set(r, (sizes.get(r) || 0) + 1);
  }
  let bestLabel = 0, bestSize = 0;
  sizes.forEach((s, l) => { if (s > bestSize) { bestSize = s; bestLabel = l; } });

  const out = new Uint8Array(data.length);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (labels[idx] === bestLabel) {
        out[idx] = 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return {
    mask: { data: out, width: w, height: h },
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    size: bestSize,
  };
}

/**
 * Returns, per row of the bounding box, the leftmost and rightmost
 * foreground pixels. Used for face-profile (anterior contour) tracing.
 */
export function rowExtents(mask, bbox) {
  const { data, width: w } = mask;
  const left = new Int32Array(bbox.h).fill(-1);
  const right = new Int32Array(bbox.h).fill(-1);
  for (let y = 0; y < bbox.h; y++) {
    const row = (bbox.y + y) * w;
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      if (data[row + x]) {
        if (left[y] < 0) left[y] = x;
        right[y] = x;
      }
    }
  }
  return { left, right };
}

/**
 * Detect the orientation of the head: returns "right" if the face
 * (anterior soft tissue) faces the right side of the image, "left"
 * otherwise. Heuristic: the side with more high-curvature variation
 * in the bony contour tends to be anterior (more convoluted nose/chin),
 * but a simpler proxy is "the side with the centroid further from the
 * skull mass center". Even simpler and quite robust: the side with the
 * larger horizontal span of the bony mask is usually the posterior
 * (cranium) side, so the face points the OTHER way.
 *
 * In practice, lateral cephs are most often acquired right-facing in
 * the West, left-facing in some setups. We expose both and let the UI
 * default to right-facing while letting the user flip.
 */
export function guessOrientation(mask, bbox) {
  // Compare upper-half centroid X to lower-half centroid X.
  // The mandible (lower) skews further forward than the cranium (upper),
  // so if lower centroid is to the right of upper centroid, face points right.
  const { data, width: w } = mask;
  const midY = bbox.y + bbox.h / 2;
  let upX = 0, upN = 0, loX = 0, loN = 0;
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    const row = y * w;
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      if (!data[row + x]) continue;
      if (y < midY) { upX += x; upN++; } else { loX += x; loN++; }
    }
  }
  if (!upN || !loN) return "right";
  const upC = upX / upN;
  const loC = loX / loN;
  return loC >= upC ? "right" : "left";
}

/**
 * Find the darkest local minimum within a search window centered on
 * (cx, cy). Used to refine landmarks like Sella that sit in dark
 * cavities of the X-ray.
 */
export function findDarkestNear(img, cx, cy, radius) {
  const { data, width: w, height: h } = img;
  const x0 = Math.max(0, Math.round(cx - radius));
  const y0 = Math.max(0, Math.round(cy - radius));
  const x1 = Math.min(w - 1, Math.round(cx + radius));
  const y1 = Math.min(h - 1, Math.round(cy + radius));
  let bestV = 256, bestX = cx | 0, bestY = cy | 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const v = data[row + x];
      if (v < bestV) { bestV = v; bestX = x; bestY = y; }
    }
  }
  return { x: bestX, y: bestY, value: bestV };
}

/**
 * Find the brightest pixel in a window — used to refine landmarks on
 * dense bone such as Pogonion.
 */
export function findBrightestNear(img, cx, cy, radius) {
  const { data, width: w, height: h } = img;
  const x0 = Math.max(0, Math.round(cx - radius));
  const y0 = Math.max(0, Math.round(cy - radius));
  const x1 = Math.min(w - 1, Math.round(cx + radius));
  const y1 = Math.min(h - 1, Math.round(cy + radius));
  let bestV = -1, bestX = cx | 0, bestY = cy | 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const v = data[row + x];
      if (v > bestV) { bestV = v; bestX = x; bestY = y; }
    }
  }
  return { x: bestX, y: bestY, value: bestV };
}
