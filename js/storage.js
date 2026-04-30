// js/storage.js
// LocalStorage-backed case persistence + JSON import/export.
//
// A "case" is a self-contained JSON document holding the patient's
// metadata, landmark coordinates, image data URL and calibration.

const STORAGE_KEY = "goldendentist.cases.v1";

export function buildCase({ patient, points, mmPerPx, imageDataUrl, notes, analysisId }) {
  return {
    schema: "goldendentist/case",
    version: 1,
    createdAt: new Date().toISOString(),
    patient: { ...patient },
    landmarks: { ...points },
    mmPerPx: mmPerPx ?? null,
    imageDataUrl: imageDataUrl ?? null,
    notes: notes ?? "",
    analysisId: analysisId ?? "steiner",
  };
}

export function listSavedCases() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCase(caseDoc) {
  const cases = listSavedCases();
  // Index by patient name + createdAt date to allow multiple per patient.
  const id = `${caseDoc.patient?.name || "Unnamed"} — ${new Date(caseDoc.createdAt).toLocaleString()}`;
  cases.push({ id, doc: caseDoc });
  // Cap to 20 cases to avoid blowing the 5MB localStorage budget with
  // embedded images.
  while (cases.length > 20) cases.shift();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cases));
  return id;
}

export function deleteCase(id) {
  const cases = listSavedCases().filter((c) => c.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cases));
}

export function exportCaseAsJSON(caseDoc) {
  const blob = new Blob([JSON.stringify(caseDoc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (caseDoc.patient?.name || "case").replace(/[^a-z0-9_-]/gi, "_");
  a.href = url;
  a.download = `${safeName}_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
