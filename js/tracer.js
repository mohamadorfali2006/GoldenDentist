// js/tracer.js
// Owns the SVG viewport: image rendering, zoom/pan, landmark placement
// and the tracing line overlay. Exposes a small event interface so the
// main app can react to landmark edits and trigger re-analysis.

import { LANDMARKS, TRACING_LINES, getLandmarkDef } from "./landmarks.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export class CephTracer extends EventTarget {
  constructor(svg, viewport) {
    super();
    this.svg = svg;
    this.viewport = viewport; // outer div (for cursor & sizing)
    this.imageEl = svg.querySelector("#ceph-image");
    this.tracingLayer = svg.querySelector("#tracing-layer");
    this.landmarkLayer = svg.querySelector("#landmark-layer");
    this.calibrationLayer = svg.querySelector("#calibration-layer");
    this.gridRect = svg.querySelector("#grid-rect");

    // Image state
    this.imageNaturalW = 0;
    this.imageNaturalH = 0;
    this.imageLoaded = false;

    // viewBox (zoom/pan) — initialized after image loads
    this.viewBox = { x: 0, y: 0, w: 1000, h: 1000 };

    // Landmarks: { [id]: {x, y} }
    this.points = {};

    // Active landmark id to place on next click
    this.activeLandmarkId = null;

    // Calibration state
    this.calibrationMode = false;
    this.calibrationPoints = [];
    this.mmPerPx = null;

    // Display options
    this.showTracing = true;
    this.showLabels = true;
    this.showGrid = false;
    this.invert = false;
    this.brightness = 100;
    this.contrast = 100;

    this._bindEvents();
  }

  // ---------- Image loading ----------

  loadImageFromDataURL(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.imageNaturalW = img.naturalWidth;
        this.imageNaturalH = img.naturalHeight;
        this.imageEl.setAttributeNS(null, "href", dataUrl);
        this.imageEl.setAttribute("x", "0");
        this.imageEl.setAttribute("y", "0");
        this.imageEl.setAttribute("width", img.naturalWidth);
        this.imageEl.setAttribute("height", img.naturalHeight);
        this.imageLoaded = true;
        this.imageDataUrl = dataUrl;
        this.fitToViewport();
        this.applyImageFilters();
        document.getElementById("empty-state").style.display = "none";
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => this.loadImageFromDataURL(reader.result).then(resolve, reject);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  applyImageFilters() {
    const filter = `brightness(${this.brightness}%) contrast(${this.contrast}%) ${this.invert ? "invert(1)" : ""}`;
    this.imageEl.setAttribute("style", `filter:${filter}`);
  }

  // ---------- Zoom & pan ----------

  setViewBox(vb) {
    this.viewBox = vb;
    this.svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    this._updateZoomReadout();
    this._updateLandmarkScales();
  }

  fitToViewport() {
    if (!this.imageLoaded) return;
    const w = this.imageNaturalW, h = this.imageNaturalH;
    this.setViewBox({ x: 0, y: 0, w, h });
    if (this.gridRect) {
      this.gridRect.setAttribute("x", 0);
      this.gridRect.setAttribute("y", 0);
      this.gridRect.setAttribute("width", w);
      this.gridRect.setAttribute("height", h);
    }
  }

  zoomBy(factor, anchor) {
    if (!this.imageLoaded) return;
    const vb = this.viewBox;
    const newW = Math.max(20, Math.min(this.imageNaturalW * 4, vb.w / factor));
    const newH = newW * (vb.h / vb.w);
    // Keep `anchor` (image coords) under the same screen position
    const ax = anchor ? anchor.x : vb.x + vb.w / 2;
    const ay = anchor ? anchor.y : vb.y + vb.h / 2;
    const fx = (ax - vb.x) / vb.w;
    const fy = (ay - vb.y) / vb.h;
    const nx = ax - fx * newW;
    const ny = ay - fy * newH;
    this.setViewBox({ x: nx, y: ny, w: newW, h: newH });
  }

  panBy(dx, dy) {
    const vb = this.viewBox;
    this.setViewBox({ x: vb.x - dx, y: vb.y - dy, w: vb.w, h: vb.h });
  }

  // Convert a mouse event to image (SVG user) coordinates.
  clientToImage(evt) {
    const pt = this.svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    const out = pt.matrixTransform(inv);
    return { x: out.x, y: out.y };
  }

  // ---------- Landmark management ----------

  setActiveLandmark(id) {
    this.activeLandmarkId = id;
    document.getElementById("active-landmark").textContent = id ? `Active: ${id}` : "Active: —";
    this.dispatchEvent(new CustomEvent("active-changed", { detail: { id } }));
  }

  setLandmark(id, point, meta = {}) {
    if (!getLandmarkDef(id)) return;
    if (!point) {
      delete this.points[id];
    } else {
      this.points[id] = {
        x: point.x,
        y: point.y,
        suggested: !!meta.suggested,
        confidence: meta.confidence,
      };
    }
    this._renderLandmark(id);
    this._renderTracing();
    this.dispatchEvent(new CustomEvent("points-changed"));
  }

  /** Mark a placed landmark as confirmed (no longer "suggested"). */
  confirmLandmark(id) {
    const p = this.points[id];
    if (!p) return;
    p.suggested = false;
    this._renderLandmark(id);
    this.dispatchEvent(new CustomEvent("points-changed"));
  }

  confirmAllSuggested() {
    let n = 0;
    Object.keys(this.points).forEach((id) => {
      if (this.points[id]?.suggested) {
        this.points[id].suggested = false;
        this._renderLandmark(id);
        n++;
      }
    });
    if (n) this.dispatchEvent(new CustomEvent("points-changed"));
    return n;
  }

  /** Bulk-replace points from an AI detector result. */
  loadSuggestedPoints(points) {
    this.points = {};
    Object.entries(points || {}).forEach(([id, pt]) => {
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        this.points[id] = {
          x: pt.x,
          y: pt.y,
          suggested: pt.suggested !== false,
          confidence: pt.confidence,
        };
      }
    });
    this._renderAllLandmarks();
    this._renderTracing();
    this.dispatchEvent(new CustomEvent("points-changed"));
  }

  clearLandmark(id) {
    this.setLandmark(id, null);
  }

  clearAllLandmarks() {
    this.points = {};
    this.landmarkLayer.innerHTML = "";
    this.tracingLayer.innerHTML = "";
    this.dispatchEvent(new CustomEvent("points-changed"));
  }

  loadPoints(points) {
    this.points = {};
    Object.entries(points || {}).forEach(([id, pt]) => {
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        this.points[id] = {
          x: pt.x,
          y: pt.y,
          suggested: !!pt.suggested,
          confidence: pt.confidence,
        };
      }
    });
    this._renderAllLandmarks();
    this._renderTracing();
    this.dispatchEvent(new CustomEvent("points-changed"));
  }

  // ---------- Calibration ----------

  startCalibration() {
    this.calibrationMode = true;
    this.calibrationPoints = [];
    this.calibrationLayer.innerHTML = "";
    this.viewport.style.cursor = "crosshair";
  }

  cancelCalibration() {
    this.calibrationMode = false;
    this.calibrationPoints = [];
    this.calibrationLayer.innerHTML = "";
  }

  finishCalibration(mm) {
    if (this.calibrationPoints.length !== 2 || !mm) return false;
    const [a, b] = this.calibrationPoints;
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    if (px <= 0) return false;
    this.mmPerPx = mm / px;
    this.calibrationMode = false;
    this.dispatchEvent(new CustomEvent("calibration-changed", { detail: { mmPerPx: this.mmPerPx } }));
    return true;
  }

  setCalibration(mmPerPx) {
    this.mmPerPx = mmPerPx;
    this.dispatchEvent(new CustomEvent("calibration-changed", { detail: { mmPerPx } }));
  }

  // ---------- Display toggles ----------

  setDisplayOption(key, value) {
    this[key] = value;
    if (key === "showGrid") {
      this.gridRect.style.display = value ? "" : "none";
    } else if (key === "showTracing") {
      this.tracingLayer.style.display = value ? "" : "none";
    } else if (key === "showLabels") {
      this.landmarkLayer.querySelectorAll(".lm-label").forEach((el) => {
        el.style.display = value ? "" : "none";
      });
    } else if (key === "invert" || key === "brightness" || key === "contrast") {
      this.applyImageFilters();
    }
  }

  // ---------- Internal rendering ----------

  _renderAllLandmarks() {
    this.landmarkLayer.innerHTML = "";
    LANDMARKS.forEach((def) => this._renderLandmark(def.id));
  }

  _renderLandmark(id) {
    // Remove existing
    const existing = this.landmarkLayer.querySelector(`[data-lm-id="${id}"]`);
    if (existing) existing.remove();

    const pt = this.points[id];
    const def = getLandmarkDef(id);
    if (!pt || !def) return;

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-lm-id", id);

    const r = this._scaledRadius();
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", pt.x);
    circle.setAttribute("cy", pt.y);
    circle.setAttribute("r", r);
    const cls = ["lm-circle", def.required ? "required" : "optional"];
    if (pt.suggested) cls.push("suggested");
    circle.setAttribute("class", cls.join(" "));
    circle.setAttribute("data-lm-id", id);
    if (Number.isFinite(pt.confidence)) {
      circle.setAttribute("data-confidence", pt.confidence.toFixed(2));
    }

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", pt.x + r * 1.5);
    label.setAttribute("y", pt.y - r * 1.2);
    label.setAttribute("class", "lm-label");
    label.setAttribute("font-size", this._scaledFontSize());
    label.textContent = def.abbr;
    if (!this.showLabels) label.style.display = "none";

    g.appendChild(circle);
    g.appendChild(label);
    this.landmarkLayer.appendChild(g);
  }

  _renderTracing() {
    this.tracingLayer.innerHTML = "";
    TRACING_LINES.forEach((seg) => {
      const a = this.points[seg.from];
      const b = this.points[seg.to];
      if (!a || !b) return;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", a.x);
      line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x);
      line.setAttribute("y2", b.y);
      const cls = ["tracing-line"];
      if (seg.kind === "aux") cls.push("aux");
      else if (seg.kind === "frankfort") cls.push("frankfort");
      else if (seg.kind === "mandibular") cls.push("mandibular");
      line.setAttribute("class", cls.join(" "));
      line.setAttribute("stroke-width", this._scaledStrokeWidth());
      this.tracingLayer.appendChild(line);
    });
  }

  _scaledRadius() {
    // Keep landmarks visually around 6 CSS pixels regardless of zoom.
    const ratio = this.viewBox.w / this.svg.clientWidth || 1;
    return Math.max(2, 6 * ratio);
  }

  _scaledFontSize() {
    const ratio = this.viewBox.w / this.svg.clientWidth || 1;
    return Math.max(8, 12 * ratio);
  }

  _scaledStrokeWidth() {
    const ratio = this.viewBox.w / this.svg.clientWidth || 1;
    return Math.max(0.5, 1.5 * ratio);
  }

  _updateLandmarkScales() {
    const r = this._scaledRadius();
    const fs = this._scaledFontSize();
    const sw = this._scaledStrokeWidth();
    this.landmarkLayer.querySelectorAll("circle.lm-circle").forEach((c) => c.setAttribute("r", r));
    this.landmarkLayer.querySelectorAll("text.lm-label").forEach((t) => t.setAttribute("font-size", fs));
    this.tracingLayer.querySelectorAll("line.tracing-line").forEach((l) => l.setAttribute("stroke-width", sw));
    this.calibrationLayer.querySelectorAll("circle.calibration-dot").forEach((c) => c.setAttribute("r", r));
    this.calibrationLayer.querySelectorAll("line.calibration-line").forEach((l) => l.setAttribute("stroke-width", sw * 1.2));
  }

  _updateZoomReadout() {
    if (!this.imageLoaded) return;
    const z = (this.imageNaturalW / this.viewBox.w) * 100;
    document.getElementById("zoom-readout").textContent = `${z.toFixed(0)}%`;
  }

  _renderCalibration() {
    this.calibrationLayer.innerHTML = "";
    const r = this._scaledRadius();
    this.calibrationPoints.forEach((p) => {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", p.x);
      c.setAttribute("cy", p.y);
      c.setAttribute("r", r);
      c.setAttribute("class", "calibration-dot");
      this.calibrationLayer.appendChild(c);
    });
    if (this.calibrationPoints.length === 2) {
      const [a, b] = this.calibrationPoints;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
      line.setAttribute("class", "calibration-line");
      line.setAttribute("stroke-width", this._scaledStrokeWidth() * 1.2);
      this.calibrationLayer.appendChild(line);
    }
  }

  // ---------- Event handling ----------

  _bindEvents() {
    let isPanning = false;
    let isDragging = null; // landmark id being dragged
    let lastClient = { x: 0, y: 0 };

    this.svg.addEventListener("mousedown", (evt) => {
      if (!this.imageLoaded) return;
      const target = evt.target;

      // Right-click on a landmark clears it
      if (evt.button === 2 && target.classList && target.classList.contains("lm-circle")) {
        const id = target.getAttribute("data-lm-id");
        this.clearLandmark(id);
        evt.preventDefault();
        return;
      }

      if (evt.button !== 0) return;

      // Click on existing landmark → start drag
      if (target.classList && target.classList.contains("lm-circle")) {
        isDragging = target.getAttribute("data-lm-id");
        target.classList.add("dragging");
        evt.preventDefault();
        return;
      }

      // Calibration click handling
      if (this.calibrationMode) {
        const p = this.clientToImage(evt);
        this.calibrationPoints.push(p);
        this._renderCalibration();
        if (this.calibrationPoints.length >= 2) {
          this.dispatchEvent(new CustomEvent("calibration-points-ready"));
        }
        evt.preventDefault();
        return;
      }

      // Active landmark placement
      if (this.activeLandmarkId) {
        const p = this.clientToImage(evt);
        this.setLandmark(this.activeLandmarkId, p);
        // Auto-advance to the next unplaced required landmark
        this.dispatchEvent(new CustomEvent("landmark-placed", { detail: { id: this.activeLandmarkId } }));
        evt.preventDefault();
        return;
      }

      // Otherwise: pan
      isPanning = true;
      this.viewport.classList.add("panning");
      lastClient = { x: evt.clientX, y: evt.clientY };
    });

    window.addEventListener("mousemove", (evt) => {
      if (this.imageLoaded) {
        const p = this.clientToImage(evt);
        document.getElementById("cursor-readout").textContent =
          `x: ${p.x.toFixed(0)}, y: ${p.y.toFixed(0)}`;
      }
      if (isDragging) {
        const p = this.clientToImage(evt);
        const prev = this.points[isDragging] || {};
        // Manual adjustment removes the "suggested" flag automatically.
        this.points[isDragging] = { x: p.x, y: p.y, suggested: false, confidence: prev.confidence };
        this._renderLandmark(isDragging);
        this._renderTracing();
        this.dispatchEvent(new CustomEvent("points-changed"));
      } else if (isPanning) {
        const dx = (evt.clientX - lastClient.x) * (this.viewBox.w / this.svg.clientWidth);
        const dy = (evt.clientY - lastClient.y) * (this.viewBox.h / this.svg.clientHeight);
        this.panBy(dx, dy);
        lastClient = { x: evt.clientX, y: evt.clientY };
      }
    });

    window.addEventListener("mouseup", () => {
      if (isDragging) {
        const el = this.landmarkLayer.querySelector(`circle.lm-circle[data-lm-id="${isDragging}"]`);
        if (el) el.classList.remove("dragging");
        isDragging = null;
      }
      isPanning = false;
      this.viewport.classList.remove("panning");
    });

    this.svg.addEventListener("contextmenu", (e) => e.preventDefault());

    this.svg.addEventListener("wheel", (evt) => {
      if (!this.imageLoaded) return;
      evt.preventDefault();
      const factor = evt.deltaY < 0 ? 1.15 : 1 / 1.15;
      const anchor = this.clientToImage(evt);
      this.zoomBy(factor, anchor);
    }, { passive: false });

    window.addEventListener("resize", () => this._updateLandmarkScales());
  }
}
