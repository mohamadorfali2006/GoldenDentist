# GoldenDentist — bundled AI training (Aariz → ONNX)

This folder is the **canonical** training pipeline for this project: **Aariz /
CEPHA29** data, a 19-landmark U-Net, weighted heat-map loss, validation MRE in
millimetres, then export to **`models/ceph.onnx`** for the browser.

> Without `models/ceph.onnx`, the front-end still works: **Auto-Trace** falls
> back to a JavaScript heuristic. Train when you want accuracy comparable to
> published Aariz numbers (~1–2 mm MRE after a full run).

## End-to-end flow

```
┌────────────┐   ┌───────────────┐   ┌──────────┐   ┌──────────┐   ┌─────────────┐
│ Aariz root │ → │ verify_       │ → │ train.py │ → │ best.pt  │ → │ export_     │
│ (Figshare) │   │ dataset.py    │   │ PyTorch  │   │          │   │ onnx.py     │
└────────────┘   └───────────────┘   └──────────┘   └──────────┘   └─────────────┘
                                                                         │
     ┌───────────────────────────────────────────────────────────────────┘
     ▼
  models/ceph.onnx  →  js/ai/onnx.js (onnxruntime-web, WASM)

Optional QA before shipping: `eval_onnx.py` (ONNX Runtime, same I/O as the browser stack).
```

Dataset: **1000** lateral cephalograms, **29** Aariz landmarks; we map to **19**
app landmarks (`landmarks_mapping.py`). Splits and `cephalogram_machine_mappings.csv`
ship with the archive.

**Figshare:** [Aariz / CEPHA29](https://doi.org/10.6084/m9.figshare.27986417.v1)

---

## 1. One-shot environment (Windows + NVIDIA)

From the **repository root**:

```powershell
.\setup_cuda.ps1
```

This creates `.venv`, installs CUDA-enabled PyTorch (`cu126` wheel), installs
`ai/requirements.txt`, and runs `ai/check_cuda.py`.

Open the folder in **VSCode** — `.vscode/settings.json` picks the venv.
Use **Run and Debug** or **Tasks** for:

| Step | Configuration / task |
|------|----------------------|
| GPU smoke test | **Check CUDA** |
| Mapping sanity-check | **Verify Aariz mapping** |
| Quick pipeline test | **Train (CUDA, smoke 2 epochs)** |
| Full training | **Train (CUDA, full)** — **80 epochs**, AMP, **weighted MSE** |
| Ship to browser | **Export ONNX** |
| Pre-browser QA | **Eval ONNX (10 valid images)** |

Launch configs prompt for the dataset path (default: `...\Downloads\Aariz\Aariz`).

---

## 2. Canonical training command

This project’s **intended** full run (also what VSCode **Train (CUDA, full)** uses):

```powershell
.\.venv\Scripts\python.exe ai\train.py `
  --data "C:\path\to\Aariz" `
  --epochs 80 --batch 4 --device cuda --amp --workers 4 `
  --ckpt-dir ai\checkpoints --pos-weight 200
```

- **`--pos-weight 200`** — weighted MSE so sparse Gaussian heat-maps do not
  collapse to “predict zero everywhere” (required for stable learning).
- **`--amp`** — mixed precision; recommended on RTX 30/40 (lower VRAM, faster).

On an **RTX 4060 8 GB**, `--batch 4 --amp` typically peaks around **5–6 GB** VRAM.

Checkpoints and **best-by-validation-MRE** weights go to `ai/checkpoints/`
(ignored by git).

---

## 3. Verify mapping (before first long run)

```powershell
python ai\verify_dataset.py --data path\to\Aariz --split TRAIN --n 5
```

Preview PNGs land in `ai/verify_previews/`. Gold = Aariz points; pink = derived
`OccA` / `OccP`. Fix `OUR_TO_AARIZ_SYMBOL` in `landmarks_mapping.py` if anything
is off.

---

## 4. Export and optional eval

```powershell
python ai\export_onnx.py --ckpt ai\checkpoints\best.pt --out models\ceph.onnx
python ai\eval_onnx.py --model models\ceph.onnx --data path\to\Aariz --num 25
```

`eval_onnx.py` reports MRE (mm) and SDR @ 2–4 mm on validation images without
opening the browser.

---

## 5. Optional: Google Colab

If you cannot use a local GPU, `train_colab.ipynb` embeds the same Python modules
and can train + export on a hosted runtime. Regenerate it after editing `ai/*.py`:

```powershell
py -3.12 ai\_build_colab_notebook.py
```

The **maintained** source of truth remains the files in **`ai/*.py`** and this
document; the notebook is a convenience mirror.

---

## File reference

| File | Role |
|------|------|
| `landmarks_mapping.py` | Aariz symbol → our 19 landmarks; `OccA` / `OccP`. |
| `model.py` | U-Net; `LANDMARK_ORDER` must match `js/ai/onnx.js`. |
| `dataset.py` | Aariz loader, senior+junior average, heat-maps, mm/px metadata. |
| `verify_dataset.py` | Visual mapping check. |
| `train.py` | Training loop: weighted MSE, AMP, val MRE (mm), SDR, checkpoints. |
| `export_onnx.py` | Single-file ONNX for `onnxruntime-web`. |
| `eval_onnx.py` | Offline ONNX QA vs. Aariz valid set. |
| `check_cuda.py` | Local CUDA / U-Net forward smoke test. |
| `requirements.txt` | Pip deps (besides the CUDA PyTorch wheel). |
| `train_colab.ipynb` | Optional Colab copy of the pipeline. |
| `_build_colab_notebook.py` | Regenerates the notebook from `ai/*.py`. |

---

## Front-end contract

`js/ai/onnx.js` expects:

- Input: `[1, 1, 640, 800]` float32, normalized as `(x/255 − 0.5) / 0.5`.
- Output: `[1, 19, 640, 800]` float32 heat-maps in ~`[0, 1]`.
- Channel order = `LANDMARK_ORDER` in `model.py`.

Change input size, channel count, or order only by editing **both** `model.py`
and `js/ai/onnx.js`.

---

## Citing Aariz

```bibtex
@article{khalid2025benchmark,
  title  = {A Benchmark Dataset for Automatic Cephalometric Landmark Detection and CVM Stage Classification},
  author = {Khalid, Muhammad Anwaar and Zulfiqar, Kanwal and Bashir, Ulfat and Shaheen, Areeba and Iqbal, Rida and Rizwan, Zarnab and Rizwan, Ghina and Fraz, Muhammad Moazam},
  journal= {Scientific Data},
  volume = {12},
  number = {1},
  pages  = {1336},
  year   = {2025},
  publisher={Nature Publishing Group UK London}
}
```
