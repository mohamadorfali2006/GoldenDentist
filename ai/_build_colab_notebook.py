"""Builds train_colab.ipynb as a fully self-contained Colab notebook.

Reads the actual source files from this folder and embeds them as
``%%writefile`` cells, so the user just opens the notebook in Colab,
mounts Drive, and runs everything top-to-bottom — no uploads, no
git clone, no copy-paste.

Run with:  py -3.12 ai/_build_colab_notebook.py
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "train_colab.ipynb"

# Files to embed and the path they should land at inside Colab.
PY_FILES = [
    "landmarks_mapping.py",
    "model.py",
    "dataset.py",
    "train.py",
    "export_onnx.py",
    "verify_dataset.py",
]
COLAB_AI_DIR = "/content/ai"


def md_cell(text: str) -> dict:
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": text.splitlines(keepends=True),
    }


def code_cell(text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": text.splitlines(keepends=True),
    }


def writefile_cell(filename: str, body: str) -> dict:
    """Builds a `%%writefile <path>\\n<body>` cell."""
    target = f"{COLAB_AI_DIR}/{filename}"
    cell_text = f"%%writefile {target}\n{body}"
    return code_cell(cell_text)


def main() -> None:
    cells: list[dict] = []

    cells.append(md_cell(
        "# GoldenDentist — Train cephalometric landmark detector on Aariz\n\n"
        "**Self-contained Colab notebook.** Run cells top to bottom.\n\n"
        "1. *Runtime → Change runtime type → T4 GPU* (free).\n"
        "2. Upload the **Aariz** dataset folder to your Google Drive once.\n"
        "3. Run all cells. The trained `ceph.onnx` is downloaded to your "
        "machine at the end.\n\n"
        "No uploads, no git clone. The notebook writes every Python "
        "source file itself."
    ))

    cells.append(md_cell("## 1. Install dependencies"))
    cells.append(code_cell(
        "%pip install --quiet torch torchvision albumentations opencv-python "
        "tqdm onnx onnxruntime"
    ))

    cells.append(md_cell(
        "## 2. Confirm GPU is attached and prepare workspace"
    ))
    cells.append(code_cell(
        "import os, torch\n"
        "os.makedirs('" + COLAB_AI_DIR + "', exist_ok=True)\n"
        "print('CUDA available:', torch.cuda.is_available())\n"
        "if torch.cuda.is_available():\n"
        "    print('Device:', torch.cuda.get_device_name(0))\n"
        "else:\n"
        "    print('NO GPU — go to Runtime > Change runtime type > T4 GPU.')\n"
    ))

    cells.append(md_cell(
        "## 3. Write every project Python file into `/content/ai/`\n\n"
        "Each cell uses Jupyter's `%%writefile` magic to materialize one "
        "module. Run them in order."
    ))

    for fname in PY_FILES:
        body = (ROOT / fname).read_text(encoding="utf-8")
        cells.append(writefile_cell(fname, body))

    cells.append(md_cell(
        "## 4. Mount Google Drive and point at the dataset\n\n"
        "Upload your `Aariz` folder (containing `train/`, `valid/`, `test/`, "
        "and `cephalogram_machine_mappings.csv`) into your Drive once. Then "
        "set `DATA_DIR` below to its path."
    ))
    cells.append(code_cell(
        "from google.colab import drive\n"
        "drive.mount('/content/drive')\n\n"
        "# ▼ EDIT THIS LINE: path inside your Drive ▼\n"
        "DATA_DIR = '/content/drive/MyDrive/Aariz'\n\n"
        "import pathlib\n"
        "for sp in ['train', 'valid', 'test']:\n"
        "    p = pathlib.Path(DATA_DIR) / sp / 'Cephalograms'\n"
        "    n = len(list(p.glob('*'))) if p.exists() else 0\n"
        "    flag = 'OK ' if n else 'MISSING'\n"
        "    print(f'  [{flag}] {sp}: {n} images at {p}')\n"
        "csv_p = pathlib.Path(DATA_DIR) / 'cephalogram_machine_mappings.csv'\n"
        "print(f'  [{ \"OK \" if csv_p.exists() else \"MISSING\" }] CSV: {csv_p}')\n"
    ))

    cells.append(md_cell(
        "## 5. Verify the landmark mapping (recommended)\n\n"
        "Renders 5 train images with all 29 raw Aariz landmarks (green) "
        "and our 19 mapped landmarks (gold / pink). Open the previews in "
        "the file browser and confirm anatomy is correct before "
        "training."
    ))
    cells.append(code_cell(
        "%cd " + COLAB_AI_DIR + "\n"
        "!python verify_dataset.py --data \"$DATA_DIR\" --split TRAIN --n 5"
    ))
    cells.append(code_cell(
        "from IPython.display import Image, display\n"
        "import glob\n"
        "for p in sorted(glob.glob('" + COLAB_AI_DIR + "/verify_previews/*.png'))[:2]:\n"
        "    print(p)\n"
        "    display(Image(p, width=600))\n"
    ))

    cells.append(md_cell(
        "## 6. Train\n\n"
        "Each epoch prints validation MRE in **millimetres** plus SDR % at "
        "2/2.5/3/4 mm — directly comparable to the published Aariz "
        "benchmark. Best checkpoint by validation MRE is kept at "
        "`ai/checkpoints/best.pt`. Roughly 1–1.5 hours on a T4 for 80 epochs."
    ))
    cells.append(code_cell(
        "%cd " + COLAB_AI_DIR + "\n"
        "!python train.py --data \"$DATA_DIR\" --epochs 80 --batch 4"
    ))

    cells.append(md_cell(
        "## 7. Export to ONNX and download to your machine"
    ))
    cells.append(code_cell(
        "%cd " + COLAB_AI_DIR + "\n"
        "!python export_onnx.py "
        "--ckpt " + COLAB_AI_DIR + "/checkpoints/best.pt "
        "--out " + COLAB_AI_DIR + "/ceph.onnx\n"
        "from google.colab import files\n"
        "files.download('" + COLAB_AI_DIR + "/ceph.onnx')\n"
    ))

    cells.append(md_cell(
        "## 8. Drop into the project\n\n"
        "Save the downloaded `ceph.onnx` at\n"
        "`<project>/models/ceph.onnx` on your machine. Refresh the "
        "GoldenDentist page in your browser. The toolbar readout switches "
        "from **AI: heuristic atlas** to **AI: ONNX trained model** and "
        "the **Auto-Trace (AI)** button now uses your trained model."
    ))

    notebook = {
        "cells": cells,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python"},
            "accelerator": "GPU",
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    OUT.write_text(json.dumps(notebook, indent=1), encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KB, {len(cells)} cells)")


if __name__ == "__main__":
    main()
