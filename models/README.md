# Trained model slot

Place **`ceph.onnx`** here so the web app can load it (see **Auto-Trace (AI)**).

- **Source**: export from your training run:
  `python ai/export_onnx.py --ckpt ai/checkpoints/best.pt --out models/ceph.onnx`
- **Contract**: 19 landmark heat-maps, 800×640 input, must match `ai/model.py`
  and `js/ai/onnx.js`.
- **Size**: about 30 MB (single file). You may commit it to git or ship it
  beside the repo; checkpoints under `ai/checkpoints/` stay gitignored.

If `ceph.onnx` is missing, the app still runs using the built-in heuristic detector.
