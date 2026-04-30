// js/analyses.js
// Cephalometric analyses, expressed declaratively. Each measurement
// describes which landmarks it needs and a `compute(pts, ctx)` function
// that returns a numeric result (degrees or millimeters), or null when
// the required landmarks are missing.
//
// `ctx.mmPerPx` is the calibration factor (or null when not calibrated).
// Linear measurements multiply pixel distances by this factor.

import {
  cephAngle3,
  acuteAngleBetweenLines,
  angleBetweenVectors,
  distance,
  distanceToLine,
  signedDistanceToLine,
  wits,
} from "./geometry.js";

/** Helper: returns true when all listed landmark ids exist in pts. */
function has(pts, ...ids) {
  return ids.every((id) => pts[id] && Number.isFinite(pts[id].x));
}

/** Convert a pixel distance to mm if calibrated, else return px value. */
function px2mm(value, ctx) {
  if (ctx.mmPerPx && Number.isFinite(ctx.mmPerPx)) {
    return value * ctx.mmPerPx;
  }
  return value;
}

/** Wraps a measurement so that missing landmarks → null result. */
function measurement(def) {
  return {
    ...def,
    evaluate(pts, ctx) {
      if (!def.requires.every((id) => has(pts, id))) {
        return { value: null, missing: def.requires.filter((id) => !has(pts, id)) };
      }
      const value = def.compute(pts, ctx);
      return { value, missing: [] };
    },
  };
}

// ---------- Individual measurements ----------

const M = {
  SNA: measurement({
    id: "SNA",
    label: "SNA",
    description: "Maxilla to cranial base (sagittal)",
    requires: ["S", "N", "A"],
    norm: { mean: 82, sd: 2, unit: "°" },
    compute: (p) => cephAngle3(p.S, p.N, p.A),
  }),

  SNB: measurement({
    id: "SNB",
    label: "SNB",
    description: "Mandible to cranial base (sagittal)",
    requires: ["S", "N", "B"],
    norm: { mean: 80, sd: 2, unit: "°" },
    compute: (p) => cephAngle3(p.S, p.N, p.B),
  }),

  ANB: measurement({
    id: "ANB",
    label: "ANB",
    description: "Maxillo-mandibular discrepancy (SNA − SNB)",
    requires: ["S", "N", "A", "B"],
    norm: { mean: 2, sd: 2, unit: "°" },
    compute: (p) => cephAngle3(p.S, p.N, p.A) - cephAngle3(p.S, p.N, p.B),
  }),

  SN_GoMe: measurement({
    id: "SN_GoMe",
    label: "SN-GoMe",
    description: "SN plane to mandibular plane (vertical)",
    requires: ["S", "N", "Go", "Me"],
    norm: { mean: 32, sd: 5, unit: "°" },
    compute: (p) => acuteAngleBetweenLines(p.S, p.N, p.Go, p.Me),
  }),

  FMA: measurement({
    id: "FMA",
    label: "FMA",
    description: "Frankfort to mandibular plane angle",
    requires: ["Po", "Or", "Go", "Me"],
    norm: { mean: 25, sd: 4, unit: "°" },
    compute: (p) => acuteAngleBetweenLines(p.Po, p.Or, p.Go, p.Me),
  }),

  IMPA: measurement({
    id: "IMPA",
    label: "IMPA",
    description: "Lower incisor to mandibular plane",
    requires: ["L1A", "L1", "Go", "Me"],
    norm: { mean: 90, sd: 5, unit: "°" },
    // Tweed convention: angle measured between L1 axis (apex→tip) and
    // mandibular plane (Go→Me); reported as the obtuse intersection
    // (typically 85–95°).
    compute: (p) => {
      const a = angleBetweenVectors(p.L1A, p.L1, p.Go, p.Me);
      return a < 90 ? 180 - a : a;
    },
  }),

  FMIA: measurement({
    id: "FMIA",
    label: "FMIA",
    description: "Lower incisor to Frankfort horizontal",
    requires: ["L1A", "L1", "Po", "Or"],
    norm: { mean: 65, sd: 5, unit: "°" },
    compute: (p) => acuteAngleBetweenLines(p.L1A, p.L1, p.Po, p.Or),
  }),

  U1_NA_ang: measurement({
    id: "U1_NA_ang",
    label: "U1-NA (angle)",
    description: "Upper incisor inclination to N-A",
    requires: ["U1A", "U1", "N", "A"],
    norm: { mean: 22, sd: 4, unit: "°" },
    compute: (p) => acuteAngleBetweenLines(p.U1A, p.U1, p.N, p.A),
  }),

  U1_NA_mm: measurement({
    id: "U1_NA_mm",
    label: "U1-NA (linear)",
    description: "Upper incisor edge to N-A line",
    requires: ["U1", "N", "A"],
    norm: { mean: 4, sd: 2, unit: "mm" },
    needsCalibration: true,
    compute: (p, ctx) => px2mm(distanceToLine(p.U1, p.N, p.A), ctx),
  }),

  L1_NB_ang: measurement({
    id: "L1_NB_ang",
    label: "L1-NB (angle)",
    description: "Lower incisor inclination to N-B",
    requires: ["L1A", "L1", "N", "B"],
    norm: { mean: 25, sd: 4, unit: "°" },
    compute: (p) => acuteAngleBetweenLines(p.L1A, p.L1, p.N, p.B),
  }),

  L1_NB_mm: measurement({
    id: "L1_NB_mm",
    label: "L1-NB (linear)",
    description: "Lower incisor edge to N-B line",
    requires: ["L1", "N", "B"],
    norm: { mean: 4, sd: 2, unit: "mm" },
    needsCalibration: true,
    compute: (p, ctx) => px2mm(distanceToLine(p.L1, p.N, p.B), ctx),
  }),

  Interincisal: measurement({
    id: "Interincisal",
    label: "U1-L1 (interincisal)",
    description: "Angle between upper and lower incisor long axes",
    requires: ["U1A", "U1", "L1A", "L1"],
    norm: { mean: 130, sd: 6, unit: "°" },
    // The interincisal angle is the obtuse angle between U1 axis (apex→tip)
    // and L1 axis (apex→tip); measured on the labial side.
    compute: (p) => {
      const a = angleBetweenVectors(p.U1A, p.U1, p.L1A, p.L1);
      return a < 90 ? 180 - a : a;
    },
  }),

  // ---------- Down's ----------

  FacialAngle: measurement({
    id: "FacialAngle",
    label: "Facial angle (FH-NPog)",
    description: "Antero-posterior chin position (Down's)",
    requires: ["Po", "Or", "N", "Pog"],
    norm: { mean: 87, sd: 3, unit: "°" },
    compute: (p) => acuteAngleBetweenLines(p.Po, p.Or, p.N, p.Pog),
  }),

  Convexity: measurement({
    id: "Convexity",
    label: "Convexity (N-A-Pog)",
    description: "Skeletal profile convexity (0° = straight)",
    requires: ["N", "A", "Pog"],
    norm: { mean: 0, sd: 5, unit: "°" },
    // Supplement of NAPog: positive when face is convex (Class II tendency).
    compute: (p) => 180 - cephAngle3(p.N, p.A, p.Pog),
  }),

  ABPlane: measurement({
    id: "ABPlane",
    label: "A-B plane",
    description: "A-B line vs N-Pog (Down's)",
    requires: ["A", "B", "N", "Pog"],
    norm: { mean: -4, sd: 3, unit: "°" },
    // Sign convention: negative when AB is anterior to NPog (typical).
    compute: (p) => {
      const ang = acuteAngleBetweenLines(p.A, p.B, p.N, p.Pog);
      // determine sign by which side of NPog the midpoint of AB falls
      const mid = { x: (p.A.x + p.B.x) / 2, y: (p.A.y + p.B.y) / 2 };
      const sign = signedDistanceToLine(mid, p.N, p.Pog) >= 0 ? 1 : -1;
      return -sign * ang; // emulate Down's negative-when-anterior convention
    },
  }),

  YAxis: measurement({
    id: "YAxis",
    label: "Y-Axis (S-Gn to FH)",
    description: "Growth direction indicator",
    requires: ["S", "Gn", "Po", "Or"],
    norm: { mean: 59, sd: 4, unit: "°" },
    compute: (p) => acuteAngleBetweenLines(p.S, p.Gn, p.Po, p.Or),
  }),

  // ---------- Wits ----------

  Wits: measurement({
    id: "Wits",
    label: "Wits Appraisal",
    description: "A-B projected on functional occlusal plane",
    requires: ["A", "B", "OccA", "OccP"],
    norm: { mean: -1, sd: 2, unit: "mm" },
    needsCalibration: true,
    compute: (p, ctx) => px2mm(wits(p.A, p.B, p.OccA, p.OccP), ctx),
  }),

  // ---------- McNamara (simplified) ----------

  CoA: measurement({
    id: "CoA",
    label: "Effective midfacial length (Ar-A)",
    description: "Mid-face length (using Articulare ≈ Condylion)",
    requires: ["Ar", "A"],
    norm: null, // age/sex specific; reported only
    needsCalibration: true,
    compute: (p, ctx) => px2mm(distance(p.Ar, p.A), ctx),
  }),

  CoGn: measurement({
    id: "CoGn",
    label: "Effective mandibular length (Ar-Gn)",
    description: "Mandible length (using Articulare ≈ Condylion)",
    requires: ["Ar", "Gn"],
    norm: null,
    needsCalibration: true,
    compute: (p, ctx) => px2mm(distance(p.Ar, p.Gn), ctx),
  }),

  MaxMandDiff: measurement({
    id: "MaxMandDiff",
    label: "Maxillomandibular differential",
    description: "Co-Gn − Co-A (McNamara)",
    requires: ["Ar", "A", "Gn"],
    norm: { mean: 25, sd: 5, unit: "mm" },
    needsCalibration: true,
    compute: (p, ctx) => px2mm(distance(p.Ar, p.Gn) - distance(p.Ar, p.A), ctx),
  }),

  LowerFH: measurement({
    id: "LowerFH",
    label: "Lower facial height (ANS-Me)",
    description: "Lower anterior face height",
    requires: ["ANS", "Me"],
    norm: null,
    needsCalibration: true,
    compute: (p, ctx) => px2mm(distance(p.ANS, p.Me), ctx),
  }),
};

// ---------- Analysis catalog ----------

export const ANALYSES = {
  steiner: {
    id: "steiner",
    name: "Steiner Analysis",
    description: "Classic skeletal/dental analysis using SN as the reference plane.",
    measurements: [M.SNA, M.SNB, M.ANB, M.SN_GoMe, M.U1_NA_ang, M.U1_NA_mm, M.L1_NB_ang, M.L1_NB_mm, M.Interincisal],
  },

  downs: {
    id: "downs",
    name: "Downs Analysis",
    description: "Profile-oriented analysis referenced to Frankfort horizontal.",
    measurements: [M.FacialAngle, M.Convexity, M.ABPlane, M.FMA, M.YAxis, M.Interincisal],
  },

  ricketts: {
    id: "ricketts",
    name: "Ricketts Analysis (simplified)",
    description: "Subset of Ricketts measurements available without Pt/Xi/DC landmarks.",
    measurements: [M.FacialAngle, M.FMA, M.Convexity, M.YAxis, M.L1_NB_ang],
  },

  mcnamara: {
    id: "mcnamara",
    name: "McNamara Analysis (simplified)",
    description: "Length-based skeletal analysis using Articulare as Condylion proxy.",
    measurements: [M.CoA, M.CoGn, M.MaxMandDiff, M.LowerFH, M.FMA, M.U1_NA_ang],
  },

  tweed: {
    id: "tweed",
    name: "Tweed Analysis",
    description: "Diagnostic triangle: FMA, FMIA, IMPA.",
    measurements: [M.FMA, M.FMIA, M.IMPA],
  },

  all: {
    id: "all",
    name: "All measurements",
    description: "Every measurement supported by the app.",
    measurements: Object.values(M),
  },
};

/**
 * Run an analysis by id and return rows describing each measurement,
 * including value, normative range, and a category badge.
 */
export function runAnalysis(analysisId, points, ctx = {}) {
  const analysis = ANALYSES[analysisId] || ANALYSES.steiner;
  const rows = analysis.measurements.map((m) => {
    const result = m.evaluate(points, ctx);
    let badge = "na";
    if (result.value !== null && m.norm && Number.isFinite(m.norm.mean)) {
      const dev = result.value - m.norm.mean;
      if (Math.abs(dev) <= m.norm.sd) badge = "norm";
      else if (dev > 0) badge = "high";
      else badge = "low";
    }
    return {
      id: m.id,
      label: m.label,
      description: m.description,
      value: result.value,
      missing: result.missing,
      norm: m.norm,
      needsCalibration: !!m.needsCalibration,
      badge,
    };
  });
  return { analysis, rows };
}
