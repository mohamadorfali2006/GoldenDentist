// js/geometry.js
// Pure geometric helpers used by the cephalometric analyzer.
// All functions operate on { x, y } points in image (pixel) coordinates.
// Note: image Y grows downward, but angle results from dot/cross products
// are invariant to this convention.

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

/** Euclidean distance between two points. */
export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Angle ABC at vertex B (between rays BA and BC), returned in degrees [0, 180].
 */
export function angleAtVertex(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const det = v1x * v2y - v1y * v2x;
  // atan2(|det|, dot) yields the unsigned angle in [0, 180].
  return Math.atan2(Math.abs(det), dot) * RAD2DEG;
}

/**
 * Angle between two vectors (a→b) and (c→d). Returns the unsigned
 * angle in [0, 180] degrees.
 */
export function angleBetweenVectors(a, b, c, d) {
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = d.x - c.x, v2y = d.y - c.y;
  const dot = v1x * v2x + v1y * v2y;
  const det = v1x * v2y - v1y * v2x;
  return Math.atan2(Math.abs(det), dot) * RAD2DEG;
}

/**
 * Angle between two LINES (each defined by 2 points), returned as
 * the acute angle in [0, 90]. Useful for plane-to-plane angles
 * (e.g. SN to GoMe, FH to MP) where direction is conventional.
 */
export function acuteAngleBetweenLines(p1, p2, p3, p4) {
  let ang = angleBetweenVectors(p1, p2, p3, p4);
  if (ang > 90) ang = 180 - ang;
  return ang;
}

/**
 * Signed angle SNA-style: gives the conventional cephalometric
 * angle (S-N to N-A) by computing angleAtVertex(S, N, A).
 * Already returns 0..180 which is the conventional reading.
 */
export function cephAngle3(p1, vertex, p3) {
  return angleAtVertex(p1, vertex, p3);
}

/**
 * Project point P onto the infinite line through A and B.
 * Returns the foot of the perpendicular and parametric t along AB.
 */
export function projectOnLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: a.x, y: a.y, t: 0 };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}

/**
 * Perpendicular (signed) distance from point P to line AB.
 * Sign uses the 2D cross product convention.
 */
export function signedDistanceToLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return 0;
  return ((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Unsigned perpendicular distance from P to line AB. */
export function distanceToLine(p, a, b) {
  return Math.abs(signedDistanceToLine(p, a, b));
}

/**
 * Line-line intersection. Returns { x, y } or null if parallel.
 * Lines are infinite, defined by (p1, p2) and (p3, p4).
 */
export function lineIntersection(p1, p2, p3, p4) {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/**
 * Wits Appraisal: signed mm/px distance between projections of A
 * and B onto the (functional) occlusal plane. Positive when A is
 * anterior to B (Class II tendency) following the standard sign.
 *
 * occA, occP define the occlusal plane (anterior point, posterior).
 */
export function wits(A, B, occA, occP) {
  const projA = projectOnLine(A, occA, occP);
  const projB = projectOnLine(B, occA, occP);
  // Distance from projB to projA along the occlusal plane direction.
  // Anterior-on-screen = lower x in radiographs facing right; we use the
  // direction (occA - occP) so positive = projA further along anterior dir.
  const dirx = occA.x - occP.x;
  const diry = occA.y - occP.y;
  const len = Math.hypot(dirx, diry);
  if (len === 0) return 0;
  const ux = dirx / len, uy = diry / len;
  const dx = projA.x - projB.x;
  const dy = projA.y - projB.y;
  return dx * ux + dy * uy;
}
