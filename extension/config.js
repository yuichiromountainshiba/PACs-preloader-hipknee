// config.js — Subspecialty configuration
// This is the only file that differs between extension variants.
// Loaded as a content script (before content.js) and via <script> in popup.html.

const SUBSPECIALTY = {
  name: 'Hip & Knee',
  id:   'hipknee',

  defaultServerUrl: 'http://localhost:8889',
  viewerParams:     '',   // viewer auto-detects hip/knee mode from port 8889

  regionKeywords: {
    hip: [
      'hip', 'pelvis', 'femur', 'acetabulum', 'acetabular',
      'sacroiliac', 'si joint', 'total hip', 'tha', 'hemiarthroplasty',
      'hemi', 'femoral neck', 'intertrochanteric', 'subtrochanteric',
      'hip arthroplasty', 'hip replacement', 'avascular necrosis', 'avn',
    ],
    knee: [
      'knee', 'tibia', 'tibial', 'patella', 'patellar',
      'total knee', 'tka', 'fibula', 'knee arthroplasty', 'knee replacement',
      'unicompartmental', 'uka', 'distal femur', 'proximal tibia',
    ],
    alignment: [
      'long leg', 'standing long', 'scanogram', 'mechanical axis',
      'eos', 'full length', 'hip to ankle', 'leg length',
    ],
  },

  modalityCodes: {
    xr: ['XR', 'CR', 'DX', 'RF'],
    ct: ['CT'],
    mr: ['MR', 'MRI'],
  },

  hideModalityFilters: true,

  regionCheckboxes: [
    { id: 'filterHip',       label: 'Hip / Pelvis',  regions: ['hip'] },
    { id: 'filterKnee',      label: 'Knee',           regions: ['knee'] },
    { id: 'filterAlignment', label: 'Long Leg / EOS', regions: ['alignment'] },
  ],
};
