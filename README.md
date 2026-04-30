# GoldenDentist — Cephalometric Tracing & Analysis

A zero-dependency, web-based orthodontic cephalometric tracing tool inspired by
**webCeph**. Upload a lateral cephalogram, place anatomical landmarks, and the
app instantly computes Steiner / Downs / Ricketts / McNamara / Tweed
measurements and produces a printable PDF report.

> **Disclaimer**: this is a research / educational prototype. It is **not** a
> medical device and must not be used for clinical decision-making.

---

## 1. Quick start

The app is pure HTML + CSS + ES-module JavaScript. It does not need a build
step, but ES modules must be served over HTTP (browsers will refuse them on
`file://`).

```bash
# Option A — Node (recommended; uses zero npm dependencies)
node server.js
# or:    npm start
# then open http://localhost:8080

# Option B — Python (stdlib only)
python serve.py
```

A small headless smoke test for the geometry + analyses kernels is available:

```bash
node test-smoke.mjs   # exits non-zero if any primitive regresses
```

That's it. Click **Upload X-ray**, then start placing landmarks.

To use the **trained** auto-tracer, add `models/ceph.onnx` (train locally with
`ai/` — see **`ai/README.md`**).

---

## 2. Architecture

```
┌─────────────────────── index.html ───────────────────────┐
│  Header (toolbar)                                        │
│ ┌─────────────┬───────────────────────┬────────────────┐ │
│ │ Patient +   │   SVG viewport        │  Analysis +    │ │
│ │ Landmark    │   (image + tracing +  │  Results +     │ │
│ │ list        │    landmarks layer)   │  Notes         │ │
│ └─────────────┴───────────────────────┴────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

Modules under `js/`:

| File           | Responsibility                                                           |
|----------------|---------------------------------------------------------------------------|
| `app.js`       | Wires UI ↔ tracer ↔ analyzer ↔ storage ↔ report. Single source of truth. |
| `tracer.js`    | SVG viewport: image, zoom/pan, landmark drag, calibration, tracing lines. |
| `landmarks.js` | Declarative list of landmarks and tracing-line segments.                  |
| `geometry.js`  | Pure math: angles, line projections, signed distance, Wits.               |
| `analyses.js`  | Declarative measurement & analysis catalog (Steiner, Downs, …).           |
| `storage.js`   | LocalStorage save/load + JSON import/export.                              |
| `report.js`    | Renders the SVG viewport to PNG and lays out the PDF via jsPDF.           |

The viewport uses a single `<svg>` element with five layers:

1. `#grid-rect` – optional 50-px grid pattern (toggleable).
2. `#ceph-image` – the X-ray as `<image>` (data-URL).
3. `#tracing-layer` – auto-rendered `<line>`s connecting placed landmarks.
4. `#landmark-layer` – `<circle>` + `<text>` per landmark, draggable.
5. `#calibration-layer` – ephemeral dots/line during scale calibration.

Zoom/pan is implemented by mutating `viewBox` (rather than CSS transforms), so
landmark coordinates are always reported in **image pixel space** regardless of
zoom level. Landmark dot/label/line widths are scaled inversely with zoom so
they remain visually constant.

---

## 3. Tech stack

| Layer               | Choice                                                              |
|---------------------|---------------------------------------------------------------------|
| Rendering           | **HTML5 + SVG** (vector overlay on top of `<image>`)                |
| Logic               | Vanilla **ES modules** — no React/Vue/bundler needed                |
| State               | Plain objects + `EventTarget` events from `CephTracer`              |
| Persistence         | `localStorage` for cases; **JSON** import/export                    |
| PDF                 | **jsPDF** (loaded from CDN); SVG → PNG via in-browser canvas        |
| Dev server          | `serve.py` (stdlib) or `npx http-server`                            |

If/when you want a backend, the natural shape is:

```
POST  /api/cases         body: case JSON              → 201 + caseId
GET   /api/cases/:id                                  → case JSON
PUT   /api/cases/:id                                                  
GET   /api/cases?patient=...                          → list
POST  /api/cases/:id/pdf                              → generated PDF
```

A FastAPI / Express service backed by Postgres (with a `cases` table holding a
single `JSONB` document plus index columns for patient name + date) is enough
for a clinic deployment. Image blobs can live on S3/MinIO; the case JSON only
carries the URL.

---

## 4. Core code structure

### Landmarks

`landmarks.js` is the single source of truth — adding a landmark there makes
it appear in the UI list, the tracing layer, the JSON schema, and the
analyses (once you reference it).

```js
{ id: "S",   abbr: "S",   name: "Sella",   description: "...", required: true }
```

### Measurement DSL

Every measurement in `analyses.js` is a small object describing what
landmarks it needs and how to compute its value. Adding a new measurement
takes 5 lines:

```js
const FacialAxis = measurement({
  id: "FacialAxis",
  label: "Facial axis",
  description: "Direction of mandibular growth (Ricketts)",
  requires: ["S", "Gn", "Po", "Or"],
  norm: { mean: 90, sd: 3, unit: "°" },
  compute: (p) => acuteAngleBetweenLines(p.S, p.Gn, p.Po, p.Or),
});
```

The analyzer (`runAnalysis`) walks the measurements, evaluates each, and
returns rows tagged with `norm | high | low | na` for color-coded display.

### Calibration

Without calibration, linear measurements (mm-based) display in pixels with a
warning. Calibration is a 2-click ritual: pick two pixels you know the
real-world distance between, type the distance in mm — the app stores
`mmPerPx` and uses it for every linear measurement and Wits.

---

## 5. Algorithms — angles & distances

All measurements ultimately reduce to four primitives in `geometry.js`:

### 5.1 Angle at a vertex (e.g. SNA)

For points P₁, V, P₃, the angle ∠P₁VP₃ is computed with `atan2`-of-cross-and-
dot, which is numerically stable and avoids the `acos`-near-±1 problem:

```js
v1 = P1 - V;  v2 = P3 - V;
dot = v1·v2;
det = v1.x*v2.y - v1.y*v2.x;
angle = atan2(|det|, dot);          // radians, [0, π]
```

Used directly for **SNA, SNB**. ANB is then `SNA - SNB`.

### 5.2 Angle between two lines (e.g. SN-GoMe, FMA)

```js
v1 = P2 - P1;  v2 = P4 - P3;
angle = atan2(|cross(v1,v2)|, dot(v1,v2));
acuteAngle = angle > 90 ? 180 - angle : angle;
```

`acuteAngleBetweenLines` returns the conventional reading (FH-MP, SN-GoMe…).

### 5.3 Angle between vectors with direction (e.g. interincisal, IMPA)

For incisor measurements we care about the orientation (apex → tip), so we
keep the angle in [0, 180] and decide whether to take it or its supplement
based on convention (interincisal is reported obtuse, FMIA acute, etc.).

### 5.4 Perpendicular projection (Wits, U1-NA mm, L1-NB mm)

```js
project(P, A, B):
    d = B - A
    t = ((P - A) · d) / (d · d)
    return A + t*d
```

For Wits, both A and B are projected onto the **functional occlusal plane**
(landmarks `OccA`/`OccP`) and the signed distance between projections is
returned, multiplied by `mmPerPx`.

### 5.5 Sign conventions

- **ANB**: `SNA − SNB`. Positive when A is anterior to B (Class I/II).
- **Convexity (Down's)**: `180 − ∠NAPog` — straight face = 0°, convex = +.
- **A-B plane (Down's)**: signed by which side of N-Pog the A-B midpoint
  falls on — slightly heuristic but matches the "negative-when-anterior"
  Down's convention for typical orientations.

Image-space Y grows downward, but every primitive uses dot/cross products
which are invariant under the Y-flip, so the math works the same way.

---

## 6. Coordinate system & data format

A saved case is a single JSON document:

```json
{
  "schema": "goldendentist/case",
  "version": 1,
  "createdAt": "2026-04-27T10:15:00.000Z",
  "patient": { "name": "Jane Doe", "age": 14, "sex": "F", "date": "2026-04-27" },
  "landmarks": {
    "S":   { "x": 412.5, "y": 290.1 },
    "N":   { "x": 705.0, "y": 305.7 },
    "...": { "x": 0,     "y": 0 }
  },
  "mmPerPx": 0.094,
  "imageDataUrl": "data:image/jpeg;base64,...",
  "notes": "Class II div.1, increased FMA.",
  "analysisId": "steiner"
}
```

Coordinates are always in **image pixel space**, with the origin at the
top-left of the radiograph. Calibration (`mmPerPx`) lives at the document
level, not per-measurement, so the same case re-renders consistently after
re-import.

---

## 7. AI auto-tracing (works out of the box)

Hit the gold **Auto-Trace (AI)** button in the toolbar. The frontend
runs a two-tier detector entirely in the browser:

1. **Trained ONNX model** — if a file exists at `models/ceph.onnx` it
   is loaded once via [onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/) (WASM
   backend by default, WebGPU when available) and used for inference.
   Expected I/O contract is documented in `js/ai/onnx.js` — keep it in
   sync with `ai/model.py::LANDMARK_ORDER`.
2. **Heuristic atlas-based detector** — runs immediately, no setup
   required. It performs CLAHE local-contrast enhancement, an Otsu
   threshold, largest-component selection and orientation detection on
   the bony silhouette, then maps a published mean-shape landmark
   atlas to the detected bounding box and snaps a handful of landmarks
   (Sella, Nasion, Pogonion, Menton, Gonion, ANS) to local features
   (darkest cavity, anterior contour, lowest contour, etc.).

The AI button always succeeds: if the trained model isn't there, it
silently falls back. The toolbar readout (`AI: …`) tells you which
backend just ran.

### AI-suggested landmark workflow

- Suggested landmarks render as **dashed pink dots** to distinguish
  them from manually placed ones.
- The landmark-list shows `AI (87%)` with the per-landmark confidence.
- **Drag any pink dot** to refine it — adjusting auto-confirms it.
- Click **Accept Suggested** to confirm everything in one go.
- Auto-detection ALWAYS keeps the user in the loop. Treat the output as
  a draft, not a diagnosis.

### Training (bundled in this repo)

The **only path this project maintains end-to-end** is: **local Python + CUDA**
on the **Aariz** benchmark, then **export** to `models/ceph.onnx`. Full detail,
commands, and the weighted-loss rationale live in **`ai/README.md`**.

```powershell
# One-time environment (repo root)
.\setup_cuda.ps1

# Typical full run (adjust --data to your Aariz root)
.\.venv\Scripts\python.exe ai\train.py --data "C:\path\to\Aariz" `
  --epochs 80 --batch 4 --device cuda --amp --workers 4 `
  --ckpt-dir ai\checkpoints --pos-weight 200

.\.venv\Scripts\python.exe ai\export_onnx.py --ckpt ai\checkpoints\best.pt --out models\ceph.onnx
```

VSCode **Run and Debug** entries (**Verify Aariz mapping**, **Train**, **Export ONNX**, **Eval ONNX**) wrap the same steps. Training prints validation **MRE in millimetres** and **SDR** at 2 / 2.5 / 3 / 4 mm. Run **`ai/verify_dataset.py`** once before a long run so landmark mapping is correct.

**Optional:** if you have no local GPU, `ai/train_colab.ipynb` mirrors these modules on Colab; regenerate it with `py -3.12 ai\_build_colab_notebook.py` after changing `ai/*.py`.

A compact **~8 M-parameter** U-Net in this repo reaches on the order of **~1–2 mm** validation MRE on Aariz after a full run with `--pos-weight 200` (use `ai/eval_onnx.py` for a quick post-export check).

## 8. AI roadmap (deeper integrations)

The cephalometric landmarking literature has converged on convolutional and
transformer architectures producing per-landmark heat-maps. A practical path:

1. **Dataset**: ISBI 2014/2015 challenge (400 images, 19 landmarks) is the
   classic baseline. CEPHA29 (2023) adds more diverse images. Augment with
   in-house data once available.
2. **Pre-processing**: resize to 800×640; CLAHE contrast normalization;
   optionally crop to a face ROI via a small detector.
3. **Model**: HRNet-W32 or a U-Net-style encoder/decoder producing 19
   heat-maps. SOTA papers (e.g. *Cephalometric landmark detection in dental
   x-rays via attention U-Net*, 2023) report < 2 mm mean radial error.
4. **Loss**: pixel-wise MSE on Gaussian heat-maps (σ ≈ 2-3 px), often
   combined with a coordinate regression head and an angular consistency
   loss between paired landmarks.
5. **Post-processing**: arg-max → sub-pixel refinement (parabolic fit on the
   3×3 neighborhood) → image-coords output.
6. **Deployment**:
   - **Server-side**: PyTorch model behind FastAPI; the frontend POSTs the
     image and receives a JSON of landmark coordinates that this app can load
     directly through `tracer.loadPoints({...})`.
   - **In-browser**: export to ONNX, run with **onnxruntime-web** (WebGPU/WASM
     backend) for offline use. A 25-MB HRNet runs at ~1 fps on a laptop GPU.
7. **UX integration**: add an **Auto-detect** button that fills landmarks
   with the model's best guess, marks them as "AI-suggested" (different
   color, requires manual confirmation per landmark), then the clinician
   adjusts and confirms. Per-landmark confidence (max-heatmap value) gates
   how aggressively to nudge the user to verify.

The current prototype's data model already supports this end-to-end: a
remote service can hand back a `{ "S": {x, y}, ... }` blob and `loadPoints`
will populate the canvas without any other change.

---

## 9. Step-by-step build plan (recap)

1. **Skeleton & layout** – HTML structure with three panels and an SVG
   viewport. ✅
2. **Image loading** – `FileReader` + SVG `<image>` (data URL). ✅
3. **Landmark editing** – drag, click-to-place, right-click-to-clear, with
   active-landmark auto-advance. ✅
4. **Zoom & pan** – `viewBox` mutation, with constant on-screen marker size. ✅
5. **Tracing overlay** – declarative line list drawn from placed landmarks. ✅
6. **Geometry kernel** – atan2-based angle helpers, projections, Wits. ✅
7. **Analyses** – Steiner / Downs / Ricketts / McNamara / Tweed / All. ✅
8. **Calibration** – two-click + known mm → `mmPerPx`. ✅
9. **Save/load** – LocalStorage + JSON import/export. ✅
10. **PDF report** – SVG→PNG snapshot + tabular results via jsPDF. ✅
11. **Roadmap** – authentication, server, AI landmark detection. ⏭

---

## 10. File map

```
GoldenDentist/
├── index.html
├── css/
│   └── styles.css
├── js/
│   ├── app.js          # main controller
│   ├── tracer.js       # SVG/image/zoom/pan/landmarks
│   ├── landmarks.js    # landmark + tracing-line definitions
│   ├── geometry.js     # math primitives
│   ├── analyses.js     # measurement + analysis DSL
│   ├── storage.js      # LocalStorage + JSON
│   ├── report.js       # PDF generation
│   └── ai/
│       ├── index.js        # backend selector (ONNX > heuristic)
│       ├── onnx.js         # onnxruntime-web wrapper
│       ├── heuristic.js    # zero-setup atlas-based detector
│       └── preprocess.js   # CLAHE / Otsu / connected-components / contour
├── ai/                 # bundled Aariz training → ONNX (see ai/README.md)
│   ├── model.py        # U-Net heat-map regressor
│   ├── landmarks_mapping.py  # Aariz-29 -> our-19 symbol map (+ derived OccA/OccP)
│   ├── dataset.py            # Aariz Train/Valid/Test loader (averages senior+junior)
│   ├── verify_dataset.py     # visual sanity-check before training
│   ├── train.py              # weighted heat-map loss, MRE (mm), AMP, checkpoints
│   ├── eval_onnx.py          # offline QA vs. valid set (before browser)
│   ├── check_cuda.py         # local CUDA install sanity-test
│   ├── train_colab.ipynb     # optional Colab mirror (see ai/README.md)
│   ├── export_onnx.py        # PyTorch → single-file ONNX
│   └── README.md
├── models/             # ceph.onnx (+ README; see models/README.md)
├── package.json        # `npm start` → http-server
├── serve.py            # `python serve.py` → http on :8080
├── server.js           # zero-dep Node static server
└── README.md
```

---

## 11. Roadmap

- Soft-tissue landmarks + esthetic-line analysis (E-line, S-line).
- Superimposition of pre/post treatment tracings.
- Multi-image timelines per patient.
- Backend (FastAPI + Postgres + S3) with auth + multi-clinic tenancy.
- AI landmark prediction (see §7).
- Native print stylesheet for direct printing without PDF.
- Localization (currently English only).
