// js/landmarks.js
// Definitions of the cephalometric landmarks used by the app.
// Each landmark has:
//   id          – stable key used in code and JSON case files
//   abbr        – short label drawn next to the dot on the canvas
//   name        – full anatomical name shown in the UI
//   description – tool-tip / hint text
//   required    – whether the landmark is needed by at least one core analysis
//
// The 12 anatomical landmarks the spec calls for are required; we add
// a few extras (Ar, U1/U1A, L1/L1A, OccA, OccP) so we can compute Tweed,
// incisor inclinations and the Wits appraisal too.

export const LANDMARKS = [
  // ---------- Cranial base / skeletal ----------
  { id: "S",   abbr: "S",   name: "Sella",                  description: "Center of sella turcica",                              required: true },
  { id: "N",   abbr: "N",   name: "Nasion",                 description: "Most anterior point of fronto-nasal suture",          required: true },
  { id: "Or",  abbr: "Or",  name: "Orbitale",               description: "Lowest point of the bony orbital margin",             required: true },
  { id: "Po",  abbr: "Po",  name: "Porion",                 description: "Highest point of external auditory meatus",            required: true },
  { id: "Ar",  abbr: "Ar",  name: "Articulare",             description: "Intersection of basisphenoid and posterior ramus",     required: false },

  // ---------- Maxilla ----------
  { id: "ANS", abbr: "ANS", name: "Anterior Nasal Spine",   description: "Tip of the anterior nasal spine",                      required: true },
  { id: "PNS", abbr: "PNS", name: "Posterior Nasal Spine",  description: "Tip of the posterior nasal spine",                     required: true },
  { id: "A",   abbr: "A",   name: "A-Point (Subspinale)",   description: "Deepest point on premaxillary contour",                required: true },

  // ---------- Mandible ----------
  { id: "B",   abbr: "B",   name: "B-Point (Supramentale)", description: "Deepest point on mandibular symphysis",                required: true },
  { id: "Pog", abbr: "Pog", name: "Pogonion",               description: "Most anterior point of bony chin",                     required: true },
  { id: "Gn",  abbr: "Gn",  name: "Gnathion",               description: "Most antero-inferior point of chin (between Pog/Me)",  required: true },
  { id: "Me",  abbr: "Me",  name: "Menton",                 description: "Most inferior point of mandibular symphysis",          required: true },
  { id: "Go",  abbr: "Go",  name: "Gonion",                 description: "Most postero-inferior point of mandibular angle",      required: true },

  // ---------- Dental ----------
  { id: "U1",  abbr: "U1",  name: "Upper Incisor Edge",     description: "Incisal tip of the most prominent upper central",      required: false },
  { id: "U1A", abbr: "U1A", name: "Upper Incisor Apex",     description: "Root apex of the upper central incisor",               required: false },
  { id: "L1",  abbr: "L1",  name: "Lower Incisor Edge",     description: "Incisal tip of the most prominent lower central",      required: false },
  { id: "L1A", abbr: "L1A", name: "Lower Incisor Apex",     description: "Root apex of the lower central incisor",               required: false },

  // ---------- Occlusion (for Wits) ----------
  { id: "OccA", abbr: "OcA", name: "Occlusal Anterior",     description: "Midpoint of incisor occlusion (functional occlusal)",  required: false },
  { id: "OccP", abbr: "OcP", name: "Occlusal Posterior",    description: "Midpoint of first-molar occlusion (functional occlusal)", required: false },
];

/** Look up a landmark definition by id. */
export function getLandmarkDef(id) {
  return LANDMARKS.find((l) => l.id === id);
}

/**
 * Tracing line definitions used to draw the cephalometric tracing on
 * top of the radiograph. `kind` controls the color/style.
 *
 *   skeletal  – default green
 *   aux       – blue dashed (constructed reference like NA, NB, APog)
 *   frankfort – pink (Po-Or)
 *   mandibular – amber (Go-Me)
 */
export const TRACING_LINES = [
  // Cranial base
  { from: "S", to: "N", kind: "skeletal" },

  // Frankfort horizontal
  { from: "Po", to: "Or", kind: "frankfort" },

  // Maxillary plane
  { from: "ANS", to: "PNS", kind: "skeletal" },

  // Mandibular plane
  { from: "Go", to: "Me", kind: "mandibular" },

  // Facial / profile
  { from: "N", to: "A", kind: "aux" },
  { from: "N", to: "B", kind: "aux" },
  { from: "N", to: "Pog", kind: "aux" },
  { from: "A", to: "Pog", kind: "aux" },

  // Y axis (Down's)
  { from: "S", to: "Gn", kind: "aux" },

  // Occlusal plane
  { from: "OccA", to: "OccP", kind: "aux" },

  // Incisor long axes
  { from: "U1A", to: "U1", kind: "skeletal" },
  { from: "L1A", to: "L1", kind: "skeletal" },

  // Ramus
  { from: "Ar", to: "Go", kind: "skeletal" },
];
