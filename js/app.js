// js/app.js
// Main application controller. Wires the UI to the tracer, analyses,
// storage and PDF report modules.

import { LANDMARKS } from "./landmarks.js";
import { CephTracer } from "./tracer.js";
import { ANALYSES, runAnalysis } from "./analyses.js";
import {
  buildCase,
  saveCase,
  listSavedCases,
  exportCaseAsJSON,
  readJSONFile,
} from "./storage.js";
import { generatePDF } from "./report.js";
import { autoDetect, initAI, backendName } from "./ai/index.js";

// ---------- Setup ----------

const svgEl = document.getElementById("ceph-svg");
const viewportEl = document.getElementById("viewport");
const tracer = new CephTracer(svgEl, viewportEl);

const state = {
  analysisId: "steiner",
  notes: "",
};

// ---------- UI: landmark list ----------

const landmarkListEl = document.getElementById("landmark-list");

function renderLandmarkList() {
  landmarkListEl.innerHTML = "";
  LANDMARKS.forEach((def) => {
    const li = document.createElement("li");
    li.dataset.id = def.id;
    li.title = def.description;
    if (tracer.activeLandmarkId === def.id) li.classList.add("active");
    if (tracer.points[def.id]) li.classList.add("placed");

    const key = document.createElement("span");
    key.className = "lm-key";
    key.textContent = def.abbr;

    const name = document.createElement("span");
    name.className = "lm-name";
    name.textContent = def.name + (def.required ? "" : "  •");

    const pt = tracer.points[def.id];
    if (pt?.suggested) li.classList.add("suggested");

    const status = document.createElement("span");
    status.className = "lm-status";
    if (pt?.suggested) {
      const c = Number.isFinite(pt.confidence) ? ` (${(pt.confidence * 100) | 0}%)` : "";
      status.textContent = `AI${c}`;
    } else if (pt) {
      status.textContent = "placed";
    } else {
      status.textContent = def.required ? "required" : "optional";
    }

    const clearBtn = document.createElement("button");
    clearBtn.className = "lm-clear";
    clearBtn.title = "Clear point";
    clearBtn.textContent = "✕";
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      tracer.clearLandmark(def.id);
    });

    li.appendChild(key);
    li.appendChild(name);
    li.appendChild(status);
    li.appendChild(clearBtn);

    li.addEventListener("click", () => {
      tracer.setActiveLandmark(def.id);
    });

    landmarkListEl.appendChild(li);
  });

  // Update progress
  const placed = LANDMARKS.filter((l) => tracer.points[l.id]).length;
  document.getElementById("landmarks-progress").textContent = `${placed} / ${LANDMARKS.length}`;
}

// ---------- Auto-advance to next required landmark ----------

function advanceToNextLandmark() {
  // Prefer required landmarks first, then optional, in declaration order.
  const ordered = [...LANDMARKS.filter((l) => l.required), ...LANDMARKS.filter((l) => !l.required)];
  const next = ordered.find((l) => !tracer.points[l.id]);
  tracer.setActiveLandmark(next ? next.id : null);
}

// ---------- Results panel ----------

const resultsBody = document.querySelector("#results-table tbody");
const resultsEmpty = document.getElementById("results-empty");
const analysisDescEl = document.getElementById("analysis-description");

function renderResults() {
  const ctx = { mmPerPx: tracer.mmPerPx };
  const { analysis, rows } = runAnalysis(state.analysisId, tracer.points, ctx);
  analysisDescEl.textContent = analysis.description;

  resultsBody.innerHTML = "";
  let anyValue = false;
  rows.forEach((row) => {
    const tr = document.createElement("tr");

    const tdLabel = document.createElement("td");
    tdLabel.textContent = row.label;
    tdLabel.title = row.description;
    tr.appendChild(tdLabel);

    const tdValue = document.createElement("td");
    tdValue.className = "value";
    if (row.value === null) {
      tdValue.textContent = "—";
      tdValue.title = `Missing: ${row.missing.join(", ")}`;
    } else {
      anyValue = true;
      const unit = row.norm?.unit || (row.needsCalibration ? (tracer.mmPerPx ? "mm" : "px") : "°");
      tdValue.textContent = `${row.value.toFixed(1)} ${unit}`;
      if (row.needsCalibration && !tracer.mmPerPx) {
        tdValue.title = "Calibrate the image to convert pixels to millimeters.";
      }
    }
    tr.appendChild(tdValue);

    const tdNorm = document.createElement("td");
    tdNorm.textContent = row.norm
      ? `${row.norm.mean} ± ${row.norm.sd} ${row.norm.unit}`
      : "—";
    tr.appendChild(tdNorm);

    const tdStatus = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${row.badge}`;
    badge.textContent = ({
      norm: "norm",
      high: "high",
      low: "low",
      na: "—",
    })[row.badge];
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    resultsBody.appendChild(tr);
  });

  resultsEmpty.style.display = anyValue ? "none" : "";
}

// ---------- Toast helper ----------

const toastEl = document.getElementById("toast");
let toastTimer = null;
function toast(msg, kind = "") {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2500);
}

// ---------- Image upload ----------

document.getElementById("image-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await tracer.loadImageFromFile(file);
    toast("Image loaded — start placing landmarks", "success");
    advanceToNextLandmark();
    renderLandmarkList();
  } catch (err) {
    console.error(err);
    toast("Failed to load image", "error");
  } finally {
    e.target.value = "";
  }
});

// ---------- Toolbar ----------

document.getElementById("btn-zoom-in").addEventListener("click", () => tracer.zoomBy(1.25));
document.getElementById("btn-zoom-out").addEventListener("click", () => tracer.zoomBy(1 / 1.25));
document.getElementById("btn-zoom-fit").addEventListener("click", () => tracer.fitToViewport());

// Fullscreen toggle for the viewport
const fsBtn = document.getElementById("btn-fullscreen");
const vpWrap = document.querySelector(".viewport-wrap");
function toggleFullscreen() {
  const active = vpWrap.classList.toggle("viewport-fullscreen");
  fsBtn.classList.toggle("active", active);
  fsBtn.title = active ? "Exit full screen (Esc)" : "Full screen (Esc to exit)";
  tracer.fitToViewport();
}
fsBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && vpWrap.classList.contains("viewport-fullscreen")) {
    toggleFullscreen();
  }
});

document.getElementById("btn-reset").addEventListener("click", () => {
  if (!confirm("Reset will clear all landmarks and patient info. Continue?")) return;
  tracer.clearAllLandmarks();
  tracer.setCalibration(null);
  document.getElementById("scale-readout").textContent = "scale: not set";
  ["pt-name", "pt-age", "pt-date"].forEach((id) => (document.getElementById(id).value = ""));
  document.getElementById("pt-sex").value = "";
  document.getElementById("notes").value = "";
  state.notes = "";
  advanceToNextLandmark();
  renderLandmarkList();
  renderResults();
  toast("Workspace reset");
});

// ---------- Display toggles ----------

document.getElementById("toggle-tracing").addEventListener("change", (e) => {
  tracer.setDisplayOption("showTracing", e.target.checked);
});
document.getElementById("toggle-labels").addEventListener("change", (e) => {
  tracer.setDisplayOption("showLabels", e.target.checked);
});
document.getElementById("toggle-grid").addEventListener("change", (e) => {
  tracer.setDisplayOption("showGrid", e.target.checked);
});
document.getElementById("toggle-invert").addEventListener("change", (e) => {
  tracer.setDisplayOption("invert", e.target.checked);
});
document.getElementById("range-brightness").addEventListener("input", (e) => {
  tracer.setDisplayOption("brightness", Number(e.target.value));
});
document.getElementById("range-contrast").addEventListener("input", (e) => {
  tracer.setDisplayOption("contrast", Number(e.target.value));
});

// ---------- Analysis selector ----------

document.getElementById("analysis-select").addEventListener("change", (e) => {
  state.analysisId = e.target.value;
  renderResults();
});

// ---------- Notes ----------

document.getElementById("notes").addEventListener("input", (e) => {
  state.notes = e.target.value;
});

// ---------- Tracer events → UI ----------

tracer.addEventListener("active-changed", () => renderLandmarkList());
tracer.addEventListener("points-changed", () => {
  renderLandmarkList();
  renderResults();
});
tracer.addEventListener("landmark-placed", () => {
  // Auto-advance to the next missing landmark for fast tracing.
  advanceToNextLandmark();
});
tracer.addEventListener("calibration-changed", (e) => {
  const mmPerPx = e.detail.mmPerPx;
  document.getElementById("scale-readout").textContent =
    mmPerPx ? `scale: ${mmPerPx.toFixed(4)} mm/px` : "scale: not set";
  renderResults();
});

// ---------- Calibration modal ----------

const calModal = document.getElementById("calibration-modal");
const calStatus = document.getElementById("cal-status");

function setCalStatus(text) { calStatus.textContent = text; }

document.getElementById("btn-calibrate").addEventListener("click", () => {
  if (!tracer.imageLoaded) {
    toast("Load an image first", "warn");
    return;
  }
  setCalStatus("Not started");
  calModal.classList.remove("hidden");
});
document.getElementById("btn-cal-cancel").addEventListener("click", () => {
  tracer.cancelCalibration();
  calModal.classList.add("hidden");
});
document.getElementById("btn-cal-pick").addEventListener("click", () => {
  tracer.startCalibration();
  setCalStatus("Click point 1 on the image…");
  calModal.classList.add("hidden");
  // We listen for points-ready below to re-open the modal.
});
tracer.addEventListener("calibration-points-ready", () => {
  setCalStatus("Two points selected. Enter the known distance below.");
  calModal.classList.remove("hidden");
});
document.getElementById("btn-cal-apply").addEventListener("click", () => {
  const mm = Number(document.getElementById("cal-mm").value);
  if (!mm || mm <= 0) {
    toast("Enter a positive distance in mm", "warn");
    return;
  }
  if (tracer.calibrationPoints.length !== 2) {
    toast("Pick two points first", "warn");
    return;
  }
  if (tracer.finishCalibration(mm)) {
    toast(`Calibrated: ${(1 / tracer.mmPerPx).toFixed(2)} px/mm`, "success");
    tracer.calibrationLayer.innerHTML = "";
    calModal.classList.add("hidden");
  } else {
    toast("Calibration failed", "error");
  }
});

// ---------- Save / load / import / export ----------

function getPatientFromForm() {
  return {
    name: document.getElementById("pt-name").value,
    age: document.getElementById("pt-age").value,
    sex: document.getElementById("pt-sex").value,
    date: document.getElementById("pt-date").value,
  };
}

function applyPatientToForm(patient) {
  if (!patient) return;
  document.getElementById("pt-name").value = patient.name || "";
  document.getElementById("pt-age").value = patient.age || "";
  document.getElementById("pt-sex").value = patient.sex || "";
  document.getElementById("pt-date").value = patient.date || "";
}

document.getElementById("btn-save").addEventListener("click", () => {
  if (!tracer.imageLoaded) {
    toast("Load an image before saving", "warn");
    return;
  }
  const doc = buildCase({
    patient: getPatientFromForm(),
    points: tracer.points,
    mmPerPx: tracer.mmPerPx,
    imageDataUrl: tracer.imageDataUrl,
    notes: state.notes,
    analysisId: state.analysisId,
  });
  const id = saveCase(doc);
  toast(`Saved: ${id}`, "success");
});

document.getElementById("btn-load").addEventListener("click", async () => {
  const cases = listSavedCases();
  if (!cases.length) { toast("No saved cases", "warn"); return; }
  // Lightweight picker via prompt — keeps things zero-dependency.
  const list = cases.map((c, i) => `${i + 1}. ${c.id}`).join("\n");
  const pick = prompt(`Load which case?\n\n${list}\n\nEnter number:`);
  const idx = Number(pick) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= cases.length) return;
  await applyCaseDoc(cases[idx].doc);
  toast("Case loaded", "success");
});

async function applyCaseDoc(doc) {
  applyPatientToForm(doc.patient);
  document.getElementById("notes").value = doc.notes || "";
  state.notes = doc.notes || "";
  state.analysisId = doc.analysisId || "steiner";
  document.getElementById("analysis-select").value = state.analysisId;
  if (doc.imageDataUrl) await tracer.loadImageFromDataURL(doc.imageDataUrl);
  if (doc.mmPerPx) tracer.setCalibration(doc.mmPerPx);
  tracer.loadPoints(doc.landmarks || {});
  advanceToNextLandmark();
  renderLandmarkList();
  renderResults();
}

document.getElementById("btn-export-json").addEventListener("click", () => {
  const doc = buildCase({
    patient: getPatientFromForm(),
    points: tracer.points,
    mmPerPx: tracer.mmPerPx,
    imageDataUrl: tracer.imageDataUrl,
    notes: state.notes,
    analysisId: state.analysisId,
  });
  exportCaseAsJSON(doc);
  toast("JSON exported", "success");
});

document.getElementById("import-json").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const doc = await readJSONFile(file);
    await applyCaseDoc(doc);
    toast("Case imported", "success");
  } catch (err) {
    console.error(err);
    toast("Failed to import JSON", "error");
  } finally {
    e.target.value = "";
  }
});

// ---------- PDF export ----------

document.getElementById("btn-pdf").addEventListener("click", async () => {
  if (!tracer.imageLoaded) {
    toast("Load an image first", "warn");
    return;
  }
  const ctx = { mmPerPx: tracer.mmPerPx };
  const { rows } = runAnalysis(state.analysisId, tracer.points, ctx);
  try {
    await generatePDF({
      patient: getPatientFromForm(),
      analysisId: state.analysisId,
      rows,
      mmPerPx: tracer.mmPerPx,
      notes: state.notes,
      svgEl,
      points: tracer.points,
    });
    toast("PDF generated", "success");
  } catch (err) {
    console.error(err);
    toast(`PDF failed: ${err.message}`, "error");
  }
});

// ---------- AI auto-detection ----------

const btnAutoDetect = document.getElementById("btn-auto-detect");
const aiSpinner = document.getElementById("ai-spinner");
const aiLabel = document.getElementById("ai-label");
const aiBackendReadout = document.getElementById("ai-backend-readout");

initAI().then(() => {
  aiBackendReadout.textContent = `AI: ${backendName()}`;
});

function setAIBusy(busy) {
  btnAutoDetect.disabled = busy;
  aiSpinner.style.display = busy ? "inline-block" : "none";
  aiLabel.textContent = busy ? "Detecting…" : "Auto-Trace (AI)";
}

btnAutoDetect.addEventListener("click", async () => {
  if (!tracer.imageLoaded) {
    toast("Load an image first", "warn");
    return;
  }
  setAIBusy(true);
  try {
    // Re-load the image off the live data URL so AI gets the original
    // (unfiltered) pixels regardless of brightness/invert toggles.
    const img = await loadHTMLImage(tracer.imageDataUrl);
    const { points, backend, orientation } = await autoDetect(img);
    tracer.loadSuggestedPoints(points);
    advanceToNextLandmark();
    const n = Object.keys(points).length;
    toast(
      `${n} landmarks suggested by ${backend === "onnx" ? "trained model" : "heuristic"}` +
      (orientation ? ` (face-${orientation})` : "") +
      ". Drag any pink dot to refine.",
      "success",
    );
  } catch (err) {
    console.error(err);
    toast(`Auto-detect failed: ${err.message}`, "error");
  } finally {
    setAIBusy(false);
  }
});

document.getElementById("btn-accept-suggested").addEventListener("click", () => {
  const n = tracer.confirmAllSuggested();
  toast(n ? `Accepted ${n} suggested landmarks` : "Nothing to accept", n ? "success" : "warn");
});

function loadHTMLImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---------- Boot ----------

document.getElementById("pt-date").value = new Date().toISOString().slice(0, 10);
renderLandmarkList();
renderResults();
advanceToNextLandmark();
