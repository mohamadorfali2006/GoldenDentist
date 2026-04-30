// Quick smoke test for the geometry + analyses kernels.
// Run with:  node test-smoke.mjs

import {
  cephAngle3,
  acuteAngleBetweenLines,
  angleBetweenVectors,
  distance,
  signedDistanceToLine,
  wits,
} from "./js/geometry.js";
import { runAnalysis } from "./js/analyses.js";

let pass = 0, fail = 0;
function approxEq(actual, expected, tol = 0.5, msg = "") {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}  expected≈${expected}  got=${actual.toFixed(3)}`);
  ok ? pass++ : fail++;
}

// --- 1. cephAngle3 — basic right angle ---
approxEq(
  cephAngle3({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }),
  90,
  0.001,
  "cephAngle3 right angle"
);

// --- 2. acute angle between lines ---
approxEq(
  acuteAngleBetweenLines({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 100 }),
  45,
  0.001,
  "45° between horizontal and diagonal"
);

// --- 3. distance ---
approxEq(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5, 0.001, "3-4-5 distance");

// --- 4. signed distance to line ---
approxEq(
  signedDistanceToLine({ x: 0, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }),
  -5,
  0.001,
  "signed distance, point above x-axis"
);

// --- 5. Wits projection ---
// Occlusal plane horizontal, A above-left of B in image coords
const w = wits(
  { x: 100, y: 50 },  // A
  { x: 80, y: 60 },   // B (slightly back)
  { x: 200, y: 100 }, // OccA (anterior, right)
  { x: 0, y: 100 }    // OccP (posterior, left)
);
approxEq(w, 20, 0.001, "Wits: A 20px anterior to B on horizontal occlusal plane");

// --- 6. Run a Steiner analysis on a synthetic Class I face ---
const pts = {
  S:   { x: 200, y: 200 },
  N:   { x: 500, y: 220 },
  Or:  { x: 520, y: 280 },
  Po:  { x: 220, y: 290 },
  ANS: { x: 530, y: 350 },
  PNS: { x: 240, y: 340 },
  A:   { x: 540, y: 380 },
  B:   { x: 525, y: 470 },
  Pog: { x: 535, y: 510 },
  Gn:  { x: 530, y: 525 },
  Me:  { x: 520, y: 540 },
  Go:  { x: 240, y: 480 },
  Ar:  { x: 230, y: 360 },
  U1:  { x: 545, y: 410 },
  U1A: { x: 525, y: 360 },
  L1:  { x: 540, y: 425 },
  L1A: { x: 520, y: 480 },
  OccA:{ x: 545, y: 420 },
  OccP:{ x: 250, y: 460 },
};

const { analysis, rows } = runAnalysis("steiner", pts, { mmPerPx: 0.1 });
console.log(`\n${analysis.name}:`);
rows.forEach((r) => {
  const v = r.value === null ? `MISSING(${r.missing.join(",")})` : `${r.value.toFixed(2)} ${r.norm?.unit ?? ""}`;
  console.log(`  ${r.label.padEnd(22)} = ${v.padEnd(16)} norm=${r.norm ? `${r.norm.mean}±${r.norm.sd}` : "-"} [${r.badge}]`);
});

// All measurements should be non-null with this synthetic dataset
const missing = rows.filter((r) => r.value === null);
if (missing.length === 0) {
  console.log("PASS  Steiner: all measurements computed");
  pass++;
} else {
  console.log(`FAIL  Steiner: ${missing.length} measurements missing`);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
