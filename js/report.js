// js/report.js
// PDF report generator using jsPDF (UMD bundle loaded from CDN in
// index.html — exposed as window.jspdf.jsPDF).
//
// The report contains:
//   • Header with patient info and analysis name
//   • An embedded snapshot of the cephalogram with tracing overlay
//   • Tabular results with normative values and status badges
//   • Clinical notes
//   • Footer with timestamp and tool attribution

import { ANALYSES } from "./analyses.js";
import { cephAngle3, acuteAngleBetweenLines, angleBetweenVectors, distanceToLine } from "./geometry.js";

/**
 * Render the SVG (#ceph-svg) plus its underlying image into a single
 * raster PNG suitable for embedding in the PDF. Returns a data URL.
 */
// Minimal stylesheet inlined into the cloned SVG so the rasterized
// version preserves landmark/tracing colors when external CSS is absent.
const SVG_INLINE_STYLES = `
  .lm-circle { fill: #d4af37; stroke: #1a1500; stroke-width: 2; }
  .lm-circle.optional { fill: #6fa8ff; }
  .lm-label {
    fill: #ffe8a8; font-size: 11px; font-weight: 600;
    paint-order: stroke; stroke: #0a1230; stroke-width: 3px;
    font-family: 'Segoe UI', Arial, sans-serif;
  }
  .tracing-line { stroke: #2bd47d; stroke-width: 1.5; fill: none; opacity: 0.9; }
  .tracing-line.aux { stroke: #6fa8ff; stroke-dasharray: 4 4; opacity: 0.8; }
  .tracing-line.frankfort { stroke: #ff7090; }
  .tracing-line.mandibular { stroke: #ffb43d; }
`;

async function renderSvgToPng(svgEl, maxW = 1200) {
  const clone = svgEl.cloneNode(true);
  const vbAttr = svgEl.getAttribute("viewBox");
  const [, , vw, vh] = (vbAttr || "0 0 1000 1000").split(/\s+/).map(Number);
  const ratio = vw / vh || 1;
  const outW = Math.min(maxW, vw);
  const outH = outW / ratio;

  clone.setAttribute("width", outW);
  clone.setAttribute("height", outH);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // Inline the styles so rasterization preserves colors.
  const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
  styleEl.textContent = SVG_INLINE_STYLES;
  clone.insertBefore(styleEl, clone.firstChild);

  const xml = new XMLSerializer().serializeToString(clone);
  const svg64 = btoa(unescape(encodeURIComponent(xml)));
  const src = `data:image/svg+xml;base64,${svg64}`;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0b1020";
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(img, 0, 0, outW, outH);
      resolve({ dataUrl: canvas.toDataURL("image/png"), w: outW, h: outH });
    };
    img.onerror = reject;
    img.src = src;
  });
}

function fmt(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function statusLabel(badge) {
  switch (badge) {
    case "norm": return "Within norm";
    case "high": return "Above norm";
    case "low":  return "Below norm";
    default:     return "—";
  }
}

export async function generatePDF({ patient, analysisId, rows, mmPerPx, notes, svgEl, includeImage = true, points = {} }) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("jsPDF library failed to load (network blocked?)");
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });

  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 30;
  let y = MARGIN;

  // ---------- Header ----------
  doc.setFillColor(15, 23, 52);
  doc.rect(0, 0, PAGE_W, 56, "F");
  doc.setFillColor(212, 175, 55);
  doc.circle(MARGIN + 10, 28, 10, "F");
  doc.setTextColor(26, 21, 0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("G", MARGIN + 7, 32);

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("GoldenDentist — Cephalometric Report", MARGIN + 28, 24);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(192, 205, 242);
  doc.text(new Date().toLocaleString(), MARGIN + 28, 40);

  y = 68;

  // ---------- Patient block (compact, at top) ----------
  doc.setTextColor(20, 20, 30);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Patient:", MARGIN, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 70);
  const patientStr = `${patient.name || "—"}  |  Age: ${patient.age || "—"}  |  Sex: ${patient.sex || "—"}  |  Date: ${patient.date || new Date().toISOString().slice(0, 10)}`;
  doc.text(patientStr, MARGIN + 48, y);
  y += 12;

  const analysis = ANALYSES[analysisId] || ANALYSES.steiner;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 30);
  doc.text(`Analysis: ${analysis.name}`, MARGIN, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(80, 80, 90);
  doc.text(analysis.description.slice(0, 120), MARGIN + 120, y);
  y += 12;

  if (mmPerPx) {
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 110);
    doc.text(`Calibration: ${(1 / mmPerPx).toFixed(2)} px/mm`, MARGIN, y);
  }
  y += 10;

  // ---------- Side-by-side: Image (left) + Table (right) ----------
  const contentTop = y;
  const contentH = PAGE_H - contentTop - 40;
  const leftColW = PAGE_W * 0.42;
  const rightColX = MARGIN + leftColW + 12;
  const rightColW = PAGE_W - rightColX - MARGIN;

  // -- Image (left column, aspect-ratio preserved) --
  if (includeImage && svgEl) {
    try {
      const { dataUrl, w, h } = await renderSvgToPng(svgEl, 1200);
      const imgAspect = w / h;
      const boxW = leftColW - 4;
      const boxH = contentH;
      let drawW, drawH;
      if (boxW / boxH > imgAspect) {
        drawH = boxH;
        drawW = drawH * imgAspect;
      } else {
        drawW = boxW;
        drawH = drawW / imgAspect;
      }
      const imgX = MARGIN + (boxW - drawW) / 2;
      const imgY = contentTop + (boxH - drawH) / 2;
      doc.addImage(dataUrl, "PNG", imgX, imgY, drawW, drawH);
    } catch (e) {
      console.warn("Failed to embed tracing image", e);
    }
  }

  // -- Results table (right column) --
  let ty = contentTop;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 30);
  doc.text("Results", rightColX, ty);
  ty += 12;

  const colMeas = 110;
  const colVal  = 52;
  const colNorm = 70;
  const colStat = 60;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setFillColor(28, 37, 71);
  doc.setTextColor(255, 255, 255);
  doc.rect(rightColX, ty - 8, rightColW, 12, "F");
  let tx = rightColX;
  doc.text("Measurement", tx + 3, ty); tx += colMeas;
  doc.text("Value", tx + 3, ty); tx += colVal;
  doc.text("Norm", tx + 3, ty); tx += colNorm;
  doc.text("Status", tx + 3, ty);
  ty += 8;

  const ROW_H = 11;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);

  rows.forEach((row, i) => {
    if (ty > PAGE_H - 44) {
      doc.addPage();
      ty = MARGIN;
    }
    if (i % 2 === 0) {
      doc.setFillColor(244, 247, 255);
      doc.rect(rightColX, ty - 7, rightColW, ROW_H, "F");
    }
    tx = rightColX;
    doc.setTextColor(20, 20, 30);

    const valueStr = row.value === null
      ? `[${row.missing.join(",")}]`
      : `${fmt(row.value)} ${row.norm?.unit || ""}`;
    const normStr = row.norm
      ? `${fmt(row.norm.mean)}±${fmt(row.norm.sd)}`
      : "—";

    doc.text(row.label.slice(0, 28), tx + 3, ty); tx += colMeas;
    doc.text(valueStr, tx + 3, ty); tx += colVal;
    doc.text(normStr, tx + 3, ty); tx += colNorm;

    const colors = { norm: [16,130,80], high: [180,110,30], low: [40,90,170], na: [120,120,130] };
    const c = colors[row.badge] || colors.na;
    doc.setTextColor(c[0], c[1], c[2]);
    doc.text(statusLabel(row.badge), tx + 3, ty);
    ty += ROW_H;
  });

  // ---------- Notes (below table or new page) ----------
  if (notes && notes.trim()) {
    ty += 8;
    if (ty > PAGE_H - 60) { doc.addPage(); ty = MARGIN; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(20, 20, 30);
    doc.text("Clinical notes", rightColX, ty);
    ty += 11;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(60, 60, 70);
    const noteLines = doc.splitTextToSize(notes, rightColW - 4);
    noteLines.forEach((line) => {
      if (ty > PAGE_H - 30) { doc.addPage(); ty = MARGIN; }
      doc.text(line, rightColX, ty); ty += 10;
    });
  }

  // ---------- Cephalometric Tracing Diagram (new page) ----------
  if (points && Object.keys(points).length >= 4) {
    doc.addPage();
    drawTracingDiagram(doc, points, PAGE_W, PAGE_H, MARGIN, mmPerPx);
  }

  // ---------- Footer on every page ----------
  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const fy = PAGE_H - 16;
    doc.setDrawColor(220);
    doc.line(MARGIN, fy - 6, PAGE_W - MARGIN, fy - 6);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text("Generated by GoldenDentist — for research/educational use only.", MARGIN, fy);
    doc.text(`Page ${p} / ${pageCount}`, PAGE_W - MARGIN - 40, fy);
  }

  const filename = `${(patient.name || "case").replace(/[^a-z0-9_-]/gi, "_")}_${analysisId}_${new Date().toISOString().slice(0,10)}.pdf`;
  doc.save(filename);
}

// ====================================================================
// Professional Lateral Cephalometric Tracing Diagram
// Dual-tracing: Blue = Standard norms, Red = Patient actual
// ====================================================================

const DEG = Math.PI / 180;

// Standard adult norms (used for generating the "ideal" tracing)
const NORMS = {
  SNA: 82, SNB: 80, ANB: 2, FMA: 25, YAxis: 59,
  GonialAngle: 130, MPA: 32,
  U1_NA_ang: 22, U1_NA_mm: 4,
  L1_NB_ang: 25, L1_NB_mm: 4,
  Interincisal: 130, Wits: -1, Convexity: 0,
};

// 14 measurements to display
const MEAS_LIST = [
  { id: "SNA",          num: 1,  label: "SNA",              unit: "\u00B0", norm: 82,  sd: 2,  req: ["S","N","A"] },
  { id: "SNB",          num: 2,  label: "SNB",              unit: "\u00B0", norm: 80,  sd: 2,  req: ["S","N","B"] },
  { id: "ANB",          num: 3,  label: "ANB",              unit: "\u00B0", norm: 2,   sd: 2,  req: ["S","N","A","B"] },
  { id: "FMA",          num: 4,  label: "FMA",              unit: "\u00B0", norm: 25,  sd: 4,  req: ["Po","Or","Go","Me"] },
  { id: "YAxis",        num: 5,  label: "Y-Axis",           unit: "\u00B0", norm: 59,  sd: 4,  req: ["S","Gn","Po","Or"] },
  { id: "GonialAngle",  num: 6,  label: "Gonial angle",     unit: "\u00B0", norm: 130, sd: 7,  req: ["Ar","Go","Me"] },
  { id: "MPA",          num: 7,  label: "Mand. plane angle",unit: "\u00B0", norm: 32,  sd: 5,  req: ["S","N","Go","Me"] },
  { id: "U1_NA_ang",    num: 8,  label: "U1 to NA (deg)",   unit: "\u00B0", norm: 22,  sd: 4,  req: ["U1A","U1","N","A"] },
  { id: "U1_NA_mm",     num: 9,  label: "U1 to NA (mm)",    unit: "mm",norm: 4,   sd: 2,  req: ["U1","N","A"] },
  { id: "L1_NB_ang",    num: 10, label: "L1 to NB (deg)",   unit: "\u00B0", norm: 25,  sd: 4,  req: ["L1A","L1","N","B"] },
  { id: "L1_NB_mm",     num: 11, label: "L1 to NB (mm)",    unit: "mm",norm: 4,   sd: 2,  req: ["L1","N","B"] },
  { id: "Interincisal", num: 12, label: "Interincisal angle",unit: "\u00B0", norm: 130,sd: 6,  req: ["U1A","U1","L1A","L1"] },
  { id: "Wits",         num: 13, label: "Wits appraisal",   unit: "mm",norm: -1,  sd: 2,  req: ["A","B","OccA","OccP"] },
  { id: "Convexity",    num: 14, label: "Facial convexity",  unit: "\u00B0", norm: 0,  sd: 5,  req: ["N","A","Pog"] },
];

// Reference planes to draw (extended dashed)
const REF_PLANES = [
  { from: "S",    to: "N",    label: "SN" },
  { from: "Po",   to: "Or",   label: "FH" },
  { from: "ANS",  to: "PNS",  label: "Palatal" },
  { from: "OccA", to: "OccP", label: "Occlusal" },
  { from: "Go",   to: "Me",   label: "Mandibular" },
];

// Structural paths to trace for each set
const TRACING_PATHS = [
  { path: ["S", "N"], label: "Cranial base" },
  { path: ["PNS", "ANS", "A"], label: "Maxilla" },
  { path: ["Ar", "Go", "Me", "Gn", "Pog", "B"], label: "Mandible" },
  { path: ["Ar", "Go"], label: "Ramus" },
  { path: ["U1A", "U1"], label: "Upper incisor" },
  { path: ["L1A", "L1"], label: "Lower incisor" },
];

/**
 * Generate standard/ideal landmark positions anchored to the patient's
 * S and N points, using norm angular values. This synthesizes where
 * landmarks SHOULD be for a "normal" patient with the same SN length.
 */
function generateStandardPoints(pts) {
  const S = pts.S, N = pts.N;
  if (!S || !N) return {};

  const snLen = Math.hypot(N.x - S.x, N.y - S.y);
  const snAngle = Math.atan2(N.y - S.y, N.x - S.x);

  function pointFromSN(angleDeg, distFraction) {
    const a = snAngle + angleDeg * DEG;
    const d = snLen * distFraction;
    return { x: S.x + Math.cos(a) * d, y: S.y + Math.sin(a) * d };
  }

  function pointFromN(angleDeg, distFraction) {
    const a = snAngle + angleDeg * DEG;
    const d = snLen * distFraction;
    return { x: N.x + Math.cos(a) * d, y: N.y + Math.sin(a) * d };
  }

  const std = {};
  std.S = { ...S };
  std.N = { ...N };

  // A-Point: SNA = 82 deg below SN, ~0.9 SN distance from N
  std.A = pointFromN((NORMS.SNA - 90) + 90, 0.92);
  // B-Point: SNB = 80 deg
  std.B = pointFromN((NORMS.SNB - 90) + 90, 1.05);

  // Porion and Orbitale (Frankfort horizontal ~7 deg below SN)
  const fhAngle = snAngle + 7 * DEG;
  std.Po = { x: S.x - Math.cos(fhAngle) * snLen * 0.15, y: S.y - Math.sin(fhAngle) * snLen * 0.15 };
  std.Or = { x: N.x + Math.cos(fhAngle + Math.PI) * snLen * 0.15, y: N.y + Math.sin(fhAngle + Math.PI) * snLen * 0.15 };

  // ANS and PNS (Palatal plane ~parallel to FH, below SN)
  const palAngle = snAngle + 2 * DEG;
  const palMid = { x: (std.A.x + N.x) / 2, y: (std.A.y + N.y) / 2 + snLen * 0.1 };
  std.ANS = { x: palMid.x + Math.cos(palAngle) * snLen * 0.35, y: palMid.y + Math.sin(palAngle) * snLen * 0.35 };
  std.PNS = { x: palMid.x - Math.cos(palAngle) * snLen * 0.35, y: palMid.y - Math.sin(palAngle) * snLen * 0.35 };

  // Mandibular plane at FMA=25 below FH
  const mpAngle = fhAngle + NORMS.FMA * DEG;

  // Menton: below A/B, along mandibular plane direction
  const meBase = { x: std.B.x + snLen * 0.05, y: std.B.y + snLen * 0.35 };
  std.Me = meBase;

  // Gonion: posterior-inferior
  std.Go = { x: std.Me.x - Math.cos(mpAngle) * snLen * 0.85, y: std.Me.y - Math.sin(mpAngle) * snLen * 0.85 };

  // Gnathion: between Pog and Me
  std.Gn = { x: (std.Me.x + std.B.x) / 2 + snLen * 0.04, y: std.Me.y - snLen * 0.03 };

  // Pogonion: most anterior chin
  std.Pog = { x: std.B.x + snLen * 0.02, y: std.B.y + snLen * 0.25 };

  // Articulare: posterior-superior to Go
  std.Ar = { x: std.Go.x + snLen * 0.05, y: std.Go.y - snLen * 0.55 };

  // Upper incisor
  const u1Base = { x: (std.A.x + std.B.x) / 2, y: (std.A.y + std.B.y) / 2 };
  std.U1 = { x: u1Base.x + snLen * 0.05, y: u1Base.y + snLen * 0.12 };
  std.U1A = { x: std.U1.x - snLen * 0.02, y: std.U1.y - snLen * 0.35 };

  // Lower incisor
  std.L1 = { x: std.U1.x - snLen * 0.02, y: std.U1.y + snLen * 0.02 };
  std.L1A = { x: std.L1.x - snLen * 0.05, y: std.L1.y + snLen * 0.35 };

  // Occlusal plane midpoints
  std.OccA = { x: (std.U1.x + std.L1.x) / 2, y: (std.U1.y + std.L1.y) / 2 };
  std.OccP = { x: std.OccA.x - snLen * 0.4, y: std.OccA.y + snLen * 0.05 };

  return std;
}

/**
 * Severity asterisks based on how many SDs away from norm.
 */
function severity(value, norm, sd) {
  if (value === undefined || value === null) return "";
  const dev = Math.abs(value - norm) / sd;
  if (dev <= 1) return "";
  if (dev <= 2) return "*";
  if (dev <= 3) return "**";
  return "***";
}

function drawTracingDiagram(doc, points, PAGE_W, PAGE_H, MARGIN, mmPerPx) {
  const available = {};
  for (const [id, pt] of Object.entries(points)) {
    if (pt && typeof pt.x === "number" && typeof pt.y === "number") {
      available[id] = pt;
    }
  }
  if (Object.keys(available).length < 3) return;

  // Generate standard positions from patient's S-N
  const stdPts = generateStandardPoints(available);

  // Compute patient measurements
  const patMeas = computeMeasurementsSync(available, mmPerPx);

  // ---------- Page Title ----------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 30);
  doc.text("Lateral Cephalometric Analysis — Dual Tracing", MARGIN, MARGIN + 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(80, 80, 90);
  doc.text("Blue = Standard norms | Red = Patient tracing | Green = within norm | Red text = outside norm", MARGIN, MARGIN + 25);

  // ---------- Layout zones ----------
  const listW = 155;
  const listX = MARGIN;
  const diagLeft = MARGIN + listW + 8;
  const diagTop = MARGIN + 36;
  const diagW = PAGE_W - diagLeft - MARGIN - 8;
  const diagH = PAGE_H - diagTop - 50;

  // ---------- LEFT: Measurement list ----------
  let ly = diagTop;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(20, 20, 30);
  doc.text("Measurements", listX, ly);
  ly += 11;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.5);
  doc.setFillColor(28, 37, 71);
  doc.setTextColor(255, 255, 255);
  doc.rect(listX, ly - 7, listW, 10, "F");
  doc.text("#", listX + 2, ly);
  doc.text("Measure", listX + 12, ly);
  doc.text("Value", listX + 82, ly);
  doc.text("Norm", listX + 108, ly);
  doc.text("Dev", listX + 134, ly);
  ly += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  MEAS_LIST.forEach(({ id, num, label, unit, norm, sd }, i) => {
    const val = patMeas[id];
    const hasVal = val !== undefined && val !== null;
    const dev = hasVal ? Math.abs(val - norm) : 0;
    const withinNorm = hasVal && dev <= sd;
    const sev = hasVal ? severity(val, norm, sd) : "";

    if (i % 2 === 0) {
      doc.setFillColor(245, 247, 255);
      doc.rect(listX, ly - 7, listW, 10, "F");
    }

    doc.setTextColor(80, 80, 90);
    doc.text(String(num), listX + 3, ly);

    doc.setTextColor(20, 20, 30);
    doc.text(label, listX + 12, ly);

    if (hasVal) {
      doc.setTextColor(withinNorm ? 16 : 190, withinNorm ? 130 : 30, withinNorm ? 80 : 30);
      doc.setFont("helvetica", "bold");
      doc.text(`${val.toFixed(1)}${unit}`, listX + 82, ly);
      doc.setFont("helvetica", "normal");
    } else {
      doc.setTextColor(160, 160, 170);
      doc.text("--", listX + 82, ly);
    }

    doc.setTextColor(100, 100, 110);
    doc.text(`${norm}${unit}`, listX + 108, ly);

    if (hasVal && !withinNorm) {
      doc.setTextColor(190, 30, 30);
      const sign = val > norm ? "+" : "";
      doc.text(`${sign}${(val - norm).toFixed(1)}${sev}`, listX + 134, ly);
    }

    ly += 10;
  });

  // ---------- CENTER/RIGHT: Dual Tracing Diagram ----------
  // Bounding box from all points (patient + standard)
  const allPts = { ...available, ...Object.fromEntries(Object.entries(stdPts).map(([k,v]) => [`_std_${k}`, v])) };
  const xs = Object.values(allPts).filter(p => p && p.x != null).map(p => p.x);
  const ys = Object.values(allPts).filter(p => p && p.y != null).map(p => p.y);
  if (xs.length < 3) return;

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;

  const dataAspect = dataW / dataH;
  const boxAspect = diagW / diagH;
  let scale, offX, offY;
  if (boxAspect > dataAspect) {
    scale = diagH / dataH;
    offX = diagLeft + (diagW - dataW * scale) / 2;
    offY = diagTop;
  } else {
    scale = diagW / dataW;
    offX = diagLeft;
    offY = diagTop + (diagH - dataH * scale) / 2;
  }

  function tx(pt) { return offX + (pt.x - minX) * scale; }
  function ty(pt) { return offY + (pt.y - minY) * scale; }

  // White background
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(210, 210, 220);
  doc.roundedRect(diagLeft - 4, diagTop - 4, diagW + 8, diagH + 8, 3, 3, "FD");

  // --- Draw STANDARD tracing (blue, dashed) ---
  const BLUE = [40, 100, 200];
  doc.setDrawColor(BLUE[0], BLUE[1], BLUE[2]);
  doc.setLineWidth(0.8);
  doc.setLineDash([4, 3], 0);
  TRACING_PATHS.forEach(({ path }) => {
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = stdPts[path[i]], p2 = stdPts[path[i + 1]];
      if (!p1 || !p2) continue;
      doc.line(tx(p1), ty(p1), tx(p2), ty(p2));
    }
  });

  // Standard reference planes (blue, thin dashed, extended)
  doc.setLineWidth(0.5);
  doc.setLineDash([2, 2], 0);
  REF_PLANES.forEach(({ from, to, label }) => {
    const p1 = stdPts[from], p2 = stdPts[to];
    if (!p1 || !p2) return;
    const x1 = tx(p1), y1 = ty(p1), x2 = tx(p2), y2 = ty(p2);
    const dx = x2 - x1, dy = y2 - y1;
    doc.line(x1 - dx * 0.25, y1 - dy * 0.25, x2 + dx * 0.25, y2 + dy * 0.25);
  });
  doc.setLineDash([], 0);

  // Standard landmark dots (blue, smaller)
  Object.entries(stdPts).forEach(([id, pt]) => {
    if (!pt) return;
    doc.setFillColor(BLUE[0], BLUE[1], BLUE[2]);
    doc.setDrawColor(BLUE[0], BLUE[1], BLUE[2]);
    doc.circle(tx(pt), ty(pt), 1.8, "F");
  });

  // --- Draw PATIENT tracing (red, solid) ---
  const RED = [200, 40, 40];
  doc.setDrawColor(RED[0], RED[1], RED[2]);
  doc.setLineWidth(1.2);
  doc.setLineDash([], 0);
  TRACING_PATHS.forEach(({ path }) => {
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = available[path[i]], p2 = available[path[i + 1]];
      if (!p1 || !p2) continue;
      doc.line(tx(p1), ty(p1), tx(p2), ty(p2));
    }
  });

  // Patient reference planes (red, medium dashed, extended)
  doc.setLineWidth(0.7);
  doc.setLineDash([3, 2], 0);
  REF_PLANES.forEach(({ from, to, label }) => {
    const p1 = available[from], p2 = available[to];
    if (!p1 || !p2) return;
    const x1 = tx(p1), y1 = ty(p1), x2 = tx(p2), y2 = ty(p2);
    const dx = x2 - x1, dy = y2 - y1;
    doc.line(x1 - dx * 0.2, y1 - dy * 0.2, x2 + dx * 0.2, y2 + dy * 0.2);
    // Plane label
    doc.setFont("helvetica", "italic");
    doc.setFontSize(5.5);
    doc.setTextColor(RED[0], RED[1], RED[2]);
    doc.text(label, x2 + dx * 0.22 + 2, y2 + dy * 0.22);
  });
  doc.setLineDash([], 0);

  // Patient landmark dots (red)
  doc.setLineWidth(0.4);
  Object.entries(available).forEach(([id, pt]) => {
    doc.setFillColor(RED[0], RED[1], RED[2]);
    doc.setDrawColor(120, 20, 20);
    doc.circle(tx(pt), ty(pt), 2.5, "FD");
  });

  // --- Measurement annotations on diagram ---
  const annotationPositions = getAnnotationPositions(available, tx, ty);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(5.5);
  MEAS_LIST.forEach(({ id, num, norm, sd }) => {
    const val = patMeas[id];
    if (val === undefined || val === null) return;
    const pos = annotationPositions[id];
    if (!pos) return;
    const withinNorm = Math.abs(val - norm) <= sd;
    doc.setTextColor(withinNorm ? 0 : 190, withinNorm ? 120 : 20, withinNorm ? 60 : 20);
    const sev = severity(val, norm, sd);
    doc.text(`${num}:${val.toFixed(1)}${sev}`, pos.x, pos.y);
  });

  // --- Legend ---
  const legY = diagTop + diagH + 12;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);

  // Blue dot + label
  doc.setFillColor(BLUE[0], BLUE[1], BLUE[2]);
  doc.circle(diagLeft + 4, legY - 2, 3, "F");
  doc.setTextColor(BLUE[0], BLUE[1], BLUE[2]);
  doc.text("Standard (Norm)", diagLeft + 10, legY);

  // Red dot + label
  doc.setFillColor(RED[0], RED[1], RED[2]);
  doc.circle(diagLeft + 90, legY - 2, 3, "F");
  doc.setTextColor(RED[0], RED[1], RED[2]);
  doc.text("Patient (Actual)", diagLeft + 96, legY);

  // Severity key
  doc.setTextColor(80, 80, 90);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  doc.text("Severity:  * mild  ** moderate  *** severe deviation from norm", diagLeft + 180, legY);
}

/**
 * Position annotations near their relevant landmarks/planes on the diagram.
 */
function getAnnotationPositions(pts, tx, ty) {
  const pos = {};

  // SNA near A point
  if (pts.A) pos.SNA = { x: tx(pts.A) + 5, y: ty(pts.A) - 6 };
  // SNB near B point
  if (pts.B) pos.SNB = { x: tx(pts.B) + 5, y: ty(pts.B) - 6 };
  // ANB between A and B
  if (pts.A && pts.B) pos.ANB = { x: (tx(pts.A) + tx(pts.B)) / 2 + 8, y: (ty(pts.A) + ty(pts.B)) / 2 };
  // FMA near Go-Me midpoint
  if (pts.Go && pts.Me) pos.FMA = { x: (tx(pts.Go) + tx(pts.Me)) / 2, y: (ty(pts.Go) + ty(pts.Me)) / 2 - 6 };
  // Y-axis near Gn
  if (pts.Gn) pos.YAxis = { x: tx(pts.Gn) + 6, y: ty(pts.Gn) - 4 };
  // Gonial angle near Go
  if (pts.Go) pos.GonialAngle = { x: tx(pts.Go) - 20, y: ty(pts.Go) + 8 };
  // MPA near SN-GoMe intersection area
  if (pts.S && pts.Go) pos.MPA = { x: (tx(pts.S) + tx(pts.Go)) / 2, y: (ty(pts.S) + ty(pts.Go)) / 2 };
  // U1 angles near U1
  if (pts.U1) pos.U1_NA_ang = { x: tx(pts.U1) + 6, y: ty(pts.U1) - 4 };
  if (pts.U1) pos.U1_NA_mm = { x: tx(pts.U1) + 6, y: ty(pts.U1) + 4 };
  // L1 angles near L1
  if (pts.L1) pos.L1_NB_ang = { x: tx(pts.L1) + 6, y: ty(pts.L1) - 4 };
  if (pts.L1) pos.L1_NB_mm = { x: tx(pts.L1) + 6, y: ty(pts.L1) + 4 };
  // Interincisal between U1 and L1
  if (pts.U1 && pts.L1) pos.Interincisal = { x: (tx(pts.U1) + tx(pts.L1)) / 2 + 8, y: (ty(pts.U1) + ty(pts.L1)) / 2 };
  // Wits near occlusal plane
  if (pts.OccA) pos.Wits = { x: tx(pts.OccA) + 6, y: ty(pts.OccA) - 6 };
  // Convexity near A
  if (pts.A && pts.Pog) pos.Convexity = { x: tx(pts.A) - 25, y: ty(pts.A) + 4 };

  return pos;
}

/**
 * Synchronous measurement computation (no dynamic imports).
 */
function computeMeasurementsSync(pts, mmPerPx) {
  const results = {};
  const has = (...ids) => ids.every(id => pts[id] && Number.isFinite(pts[id].x));
  const px2mm = (v) => (mmPerPx && Number.isFinite(mmPerPx)) ? v * mmPerPx : v;

  if (has("S","N","A")) results.SNA = cephAngle3(pts.S, pts.N, pts.A);
  if (has("S","N","B")) results.SNB = cephAngle3(pts.S, pts.N, pts.B);
  if (has("S","N","A","B")) results.ANB = results.SNA - results.SNB;
  if (has("Po","Or","Go","Me")) results.FMA = acuteAngleBetweenLines(pts.Po, pts.Or, pts.Go, pts.Me);
  if (has("S","Gn","Po","Or")) results.YAxis = acuteAngleBetweenLines(pts.S, pts.Gn, pts.Po, pts.Or);
  if (has("Ar","Go","Me")) {
    const v1x = pts.Ar.x - pts.Go.x, v1y = pts.Ar.y - pts.Go.y;
    const v2x = pts.Me.x - pts.Go.x, v2y = pts.Me.y - pts.Go.y;
    const dot = v1x * v2x + v1y * v2y;
    const det = v1x * v2y - v1y * v2x;
    const a = Math.atan2(Math.abs(det), dot) * (180 / Math.PI);
    results.GonialAngle = a;
  }
  if (has("S","N","Go","Me")) results.MPA = acuteAngleBetweenLines(pts.S, pts.N, pts.Go, pts.Me);
  if (has("U1A","U1","N","A")) results.U1_NA_ang = acuteAngleBetweenLines(pts.U1A, pts.U1, pts.N, pts.A);
  if (has("U1","N","A")) results.U1_NA_mm = px2mm(distanceToLine(pts.U1, pts.N, pts.A));
  if (has("L1A","L1","N","B")) results.L1_NB_ang = acuteAngleBetweenLines(pts.L1A, pts.L1, pts.N, pts.B);
  if (has("L1","N","B")) results.L1_NB_mm = px2mm(distanceToLine(pts.L1, pts.N, pts.B));
  if (has("U1A","U1","L1A","L1")) {
    const a = angleBetweenVectors(pts.U1A, pts.U1, pts.L1A, pts.L1);
    results.Interincisal = a < 90 ? 180 - a : a;
  }
  if (has("A","B","OccA","OccP")) {
    const ox = pts.OccP.x - pts.OccA.x, oy = pts.OccP.y - pts.OccA.y;
    const len2 = ox * ox + oy * oy;
    if (len2 > 0) {
      const tA = ((pts.A.x - pts.OccA.x) * ox + (pts.A.y - pts.OccA.y) * oy) / len2;
      const tB = ((pts.B.x - pts.OccA.x) * ox + (pts.B.y - pts.OccA.y) * oy) / len2;
      results.Wits = px2mm((tA - tB) * Math.sqrt(len2));
    }
  }
  if (has("N","A","Pog")) results.Convexity = 180 - cephAngle3(pts.N, pts.A, pts.Pog);

  return results;
}
