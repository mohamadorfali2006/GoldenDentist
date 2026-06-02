// js/report.js
// PDF report generator built from the new GoldenDentist HTML design.
//
// Two A4 pages are rendered as real DOM (off-screen), captured with
// html2canvas and placed into a jsPDF document:
//   • Page 1 — cover "skin" (logo, title, patient info, clinical notes)
//   • Page 2 — cephalogram snapshot + analysis results table
//
// jsPDF (UMD) and html2canvas are loaded from CDN in index.html and
// exposed as window.jspdf.jsPDF and window.html2canvas.

import { ANALYSES } from "./analyses.js";
import { cephAngle3 } from "./geometry.js";

// A4 page size in CSS pixels at 96 DPI (used for both templates).
const A4_W = 794;
const A4_H = 1123;

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

/**
 * Render the SVG (#ceph-svg) plus its underlying image into a single
 * raster PNG suitable for embedding in the report. Returns a data URL.
 */
async function renderSvgToPng(svgEl, maxW = 1400) {
  const clone = svgEl.cloneNode(true);
  const vbAttr = svgEl.getAttribute("viewBox");
  const [, , vw, vh] = (vbAttr || "0 0 1000 1000").split(/\s+/).map(Number);
  const ratio = vw / vh || 1;
  const outW = Math.min(maxW, vw);
  const outH = outW / ratio;

  clone.setAttribute("width", outW);
  clone.setAttribute("height", outH);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

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
  if (value === null || value === undefined || !Number.isFinite(value)) return "\u2014";
  return value.toFixed(digits);
}

function statusLabel(badge) {
  switch (badge) {
    case "norm": return "Within norm";
    case "high": return "Above norm";
    case "low":  return "Below norm";
    default:     return "\u2014";
  }
}

function statusColor(badge) {
  switch (badge) {
    case "norm": return "#108250";
    case "high": return "#b46e1e";
    case "low":  return "#285aaa";
    default:     return "#7a7a85";
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Determine a simple skeletal class label from the ANB angle.
 */
function skeletalClass(points) {
  const p = points || {};
  const has = (...ids) => ids.every((id) => p[id] && Number.isFinite(p[id].x));
  if (!has("S", "N", "A", "B")) return null;
  const sna = cephAngle3(p.S, p.N, p.A);
  const snb = cephAngle3(p.S, p.N, p.B);
  const anb = sna - snb;
  if (!Number.isFinite(anb)) return null;
  if (anb < 0) return "Class III";
  if (anb <= 4) return "Class I";
  return "Class II";
}

// ---------- Scoped CSS for the rendered report pages ----------
const REPORT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&display=swap');

.gd-report-page { box-sizing: border-box; }
.gd-report-page * { box-sizing: border-box; margin: 0; padding: 0; }
.gd-report-page {
  width: ${A4_W}px;
  height: ${A4_H}px;
  background: #ffffff;
  position: relative;
  overflow: hidden;
  font-family: 'Montserrat', 'ITC Avant Garde Gothic', sans-serif;
}

/* ===== Page 1 — Cover ===== */
.gd-cover .logo { position: absolute; top: 40px; right: 40px; z-index: 10; }
.gd-cover .logo img { width: 230px; height: auto; }
.gd-cover .class-info {
  position: absolute; top: 150px; left: 0;
  background: #dfb74c; color: #000; font-weight: 700; font-size: 20px;
  padding: 10px 30px; border-top-right-radius: 25px; border-bottom-right-radius: 25px;
  z-index: 10;
}
.gd-cover .gray-shape {
  position: absolute; top: 200px; left: 0; width: 380px; height: 180px;
  background: #c1c5cd; border-bottom-right-radius: 100px; z-index: 1;
}
.gd-cover .yellow-card {
  position: absolute; top: 380px; left: 0; width: 78%; height: 430px;
  background: #dfb74c; border-bottom-right-radius: 80px; border-top-right-radius: 80px;
  padding: 50px 40px; z-index: 2; display: flex; flex-direction: column; justify-content: space-between;
}
.gd-cover .title-section h1 { color: #1a2342; font-size: 42px; font-weight: 900; margin-bottom: 5px; letter-spacing: 1px; }
.gd-cover .title-section h2 { color: #1a2342; font-size: 32px; font-weight: 400; }
.gd-cover .horizontal-braces { width: 100%; max-width: 500px; margin: 10px 0; min-height: 80px; object-fit: contain; }
.gd-cover .patient-info p { color: #1a2342; font-size: 24px; margin-bottom: 8px; }
.gd-cover .notes-section {
  position: absolute; bottom: 0; left: 0; width: 100%; height: 313px;
  background: #3b4158; padding: 50px 40px; z-index: 1;
}
.gd-cover .note-row { display: flex; align-items: flex-end; margin-bottom: 18px; }
.gd-cover .note-label { color: #fff; font-size: 28px; font-weight: 300; margin-right: 15px; }
.gd-cover .note-line {
  width: 100%; color: #fff; font-size: 16px; line-height: 1.4;
  border-bottom: 1px dashed #fff; margin-bottom: 22px; min-height: 22px;
}
.gd-cover .note-row .note-line { margin-bottom: 0; }

/* ===== Page 2 — Analysis ===== */
.gd-analysis { display: flex; }
.gd-analysis .sidebar {
  width: 35px; height: 100%; background: #3b4158; position: absolute; right: 0; top: 0; z-index: 5;
}
.gd-analysis .main-content { width: calc(100% - 35px); height: 100%; display: flex; flex-direction: column; }
.gd-analysis .header { display: flex; align-items: center; height: 55px; border-bottom: 1px solid #d1d1d1; }
.gd-analysis .yellow-tab {
  background: #dfb74c; color: #1a2342; font-size: 26px; font-weight: 700; height: 100%;
  padding: 0 30px; display: flex; align-items: center; border-bottom-right-radius: 25px;
}
.gd-analysis .patient-name { color: #3b4158; font-size: 16px; margin-left: 20px; flex-grow: 1; }
.gd-analysis .logo { font-size: 22px; color: #000; padding-right: 20px; }
.gd-analysis .logo strong { font-weight: 900; }
.gd-analysis .content-area { flex-grow: 1; padding: 30px 35px; display: flex; flex-direction: column; }
.gd-analysis .analysis-title { color: #1a2342; font-size: 22px; font-weight: 700; margin-bottom: 6px; }
.gd-analysis .analysis-desc { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
.gd-analysis .xray-wrap {
  width: 100%; height: 420px; background: #0b1020; border-radius: 10px; overflow: hidden;
  display: flex; align-items: center; justify-content: center; margin-bottom: 22px;
}
.gd-analysis .xray-wrap img { max-width: 100%; max-height: 100%; object-fit: contain; }
.gd-analysis table.results { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.gd-analysis table.results thead th {
  background: #1a2342; color: #fff; text-align: left; padding: 9px 12px; font-weight: 700;
}
.gd-analysis table.results tbody td { padding: 7px 12px; color: #1a2342; border-bottom: 1px solid #e6e8ef; }
.gd-analysis table.results tbody tr:nth-child(even) { background: #f4f7ff; }
.gd-analysis table.results td.value { font-weight: 700; }
.gd-analysis table.results td.status { font-weight: 700; }
`;

/**
 * Build the cover page (Page 1) DOM node.
 */
function buildCoverPage({ name, caseId, sex, age, date, klass, notes }) {
  const page = document.createElement("div");
  page.className = "gd-report-page gd-cover";

  const noteLines = (notes || "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 6);
  while (noteLines.length < 6) noteLines.push("");

  page.innerHTML = `
    <div class="logo"><img src="css/image-removebg-preview (7).png" alt="GoldenDentist" /></div>
    <div class="class-info">${escapeHtml(klass || "Cephalometric")}</div>
    <div class="gray-shape"></div>
    <div class="yellow-card">
      <div class="title-section">
        <h1>ORTHODONTIC CASE</h1>
        <h2>ANALYSIS REPORT</h2>
      </div>
      <img src="css/Ultra-high-resolution_4K_enhancement_based_strictly_202605231457-Photoroom.png" class="horizontal-braces" alt="" />
      <div class="patient-info">
        <p>${escapeHtml(name)}${caseId ? " - " + escapeHtml(caseId) : ""}</p>
        <p>${escapeHtml(sex)} - ${escapeHtml(age)}</p>
        <p>${escapeHtml(date)}</p>
      </div>
    </div>
    <div class="notes-section">
      <div class="note-row">
        <span class="note-label">Note :</span>
        <div class="note-line">${escapeHtml(noteLines[0])}</div>
      </div>
      <div class="note-line">${escapeHtml(noteLines[1])}</div>
      <div class="note-line">${escapeHtml(noteLines[2])}</div>
      <div class="note-line">${escapeHtml(noteLines[3])}</div>
      <div class="note-line">${escapeHtml(noteLines[4])}</div>
      <div class="note-line">${escapeHtml(noteLines[5])}</div>
    </div>
  `;
  return page;
}

/**
 * Build the analysis page (Page 2) DOM node with X-ray + results table.
 */
function buildAnalysisPage({ name, analysis, xrayDataUrl, rows }) {
  const page = document.createElement("div");
  page.className = "gd-report-page gd-analysis";

  const rowsHtml = (rows || []).map((row) => {
    const valueStr = row.value === null || row.value === undefined
      ? `[${(row.missing || []).join(",")}]`
      : `${fmt(row.value)} ${row.norm?.unit || ""}`.trim();
    const normStr = row.norm ? `${fmt(row.norm.mean)} \u00B1 ${fmt(row.norm.sd)}` : "\u2014";
    return `
      <tr>
        <td>${escapeHtml(row.label)}</td>
        <td class="value">${escapeHtml(valueStr)}</td>
        <td>${escapeHtml(normStr)}</td>
        <td class="status" style="color:${statusColor(row.badge)}">${escapeHtml(statusLabel(row.badge))}</td>
      </tr>`;
  }).join("");

  const xrayHtml = xrayDataUrl
    ? `<div class="xray-wrap"><img src="${xrayDataUrl}" alt="Cephalogram" /></div>`
    : "";

  page.innerHTML = `
    <div class="main-content">
      <div class="header">
        <div class="yellow-tab">Cephalometry</div>
        <div class="patient-name">${escapeHtml(name)}</div>
        <div class="logo"><strong>Golden</strong>Dentist</div>
      </div>
      <div class="content-area">
        <div class="analysis-title">${escapeHtml(analysis.name)}</div>
        <div class="analysis-desc">${escapeHtml((analysis.description || "").slice(0, 160))}</div>
        ${xrayHtml}
        <table class="results">
          <thead>
            <tr><th>Measurement</th><th>Value</th><th>Norm</th><th>Status</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
    <div class="sidebar"></div>
  `;
  return page;
}

/**
 * Wait for all <img> elements inside a node to finish loading.
 */
function waitForImages(node) {
  const imgs = Array.from(node.querySelectorAll("img"));
  return Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener("load", resolve, { once: true });
      img.addEventListener("error", resolve, { once: true });
    });
  }));
}

/**
 * Render a page node to a canvas via html2canvas.
 */
async function capturePage(pageNode, host) {
  host.appendChild(pageNode);
  await waitForImages(pageNode);
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* ignore */ }
  }
  // Small delay to let background images / fonts settle.
  await new Promise((r) => setTimeout(r, 60));
  const canvas = await window.html2canvas(pageNode, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
    width: A4_W,
    height: A4_H,
    windowWidth: A4_W,
    windowHeight: A4_H,
    logging: false,
  });
  host.removeChild(pageNode);
  return canvas.toDataURL("image/jpeg", 0.92);
}

export async function generatePDF({ patient, analysisId, rows, mmPerPx, notes, svgEl, includeImage = true, points = {} }) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("jsPDF library failed to load (network blocked?)");
  }
  if (!window.html2canvas) {
    throw new Error("html2canvas library failed to load (network blocked?)");
  }

  const analysis = ANALYSES[analysisId] || ANALYSES.steiner;

  // Rasterize the cephalogram (image + tracing overlay).
  let xrayDataUrl = null;
  if (includeImage && svgEl) {
    try {
      const { dataUrl } = await renderSvgToPng(svgEl, 1400);
      xrayDataUrl = dataUrl;
    } catch (e) {
      console.warn("Failed to rasterize cephalogram", e);
    }
  }

  const name = patient.name || "\u2014";
  const age = patient.age ? `${patient.age}` : "\u2014";
  const sex = patient.sex || "\u2014";
  const date = patient.date || new Date().toISOString().slice(0, 10);
  const klass = skeletalClass(points);

  // Off-screen host that carries the scoped stylesheet.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:" + A4_W + "px;z-index:-1;";
  const styleEl = document.createElement("style");
  styleEl.textContent = REPORT_CSS;
  host.appendChild(styleEl);
  document.body.appendChild(host);

  try {
    const coverPage = buildCoverPage({ name, caseId: "", sex, age, date, klass, notes });
    const analysisPage = buildAnalysisPage({ name, analysis, xrayDataUrl, rows });

    const coverImg = await capturePage(coverPage, host);
    const analysisImg = await capturePage(analysisPage, host);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
    const PAGE_W = doc.internal.pageSize.getWidth();
    const PAGE_H = doc.internal.pageSize.getHeight();

    doc.addImage(coverImg, "JPEG", 0, 0, PAGE_W, PAGE_H);
    doc.addPage();
    doc.addImage(analysisImg, "JPEG", 0, 0, PAGE_W, PAGE_H);

    const filename = `${(patient.name || "case").replace(/[^a-z0-9_-]/gi, "_")}_${analysisId}_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(filename);
  } finally {
    document.body.removeChild(host);
  }
}
