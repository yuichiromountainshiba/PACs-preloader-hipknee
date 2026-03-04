// background.js — Service worker for PACS Preloader extension
// Handles the preload loop so it survives the popup being closed.

let isPreloading = false;
let pacsTabId = null;
let scheduledPatients = [];
const refreshesInProgress = new Set();

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PACS Preloader] Extension installed');
  chrome.alarms.create('pollRefreshes', { periodInMinutes: 10 / 60 }); // every 10s
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'pollRefreshes') pollPendingRefreshes();
});

// ── Message listener (from popup) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startPreload') {
    runPreload(msg).catch(console.error);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'getStatus') {
    sendResponse({ isPreloading, patientCount: scheduledPatients.length });
    return true;
  }
});

// Send a message to the popup; silently ignore if popup is closed.
function postToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}


// ── Preload loop ──
async function runPreload({ patients, serverUrl, clinicDate, filters, tabId }) {
  if (isPreloading) return;
  isPreloading = true;
  pacsTabId = tabId;
  scheduledPatients = patients;

  postToPopup({ action: 'preloadLog', text: `Starting preload: ${patients.length} patient(s)${clinicDate ? ' — clinic ' + clinicDate : ''}`, cls: 'info' });

  let totalImages = 0;
  for (let i = 0; i < patients.length; i++) {
    const pt = patients[i];
    postToPopup({ action: 'preloadProgress', current: i, total: patients.length, label: `Searching: ${pt.name}` });
    postToPopup({ action: 'preloadLog', text: `\n[${i + 1}/${patients.length}] ${pt.name} (DOB: ${pt.dob})`, cls: 'info' });
    try {
      totalImages += await preloadPatient(pt, serverUrl, clinicDate, filters);
    } catch (err) {
      postToPopup({ action: 'preloadLog', text: `  ✗ Error: ${err.message}`, cls: 'error' });
    }
    await sleep(500);
  }

  postToPopup({ action: 'preloadProgress', current: patients.length, total: patients.length, label: 'Done!' });
  postToPopup({ action: 'preloadLog', text: `\n✓ Preload complete! ${totalImages} total image(s) saved.`, cls: 'success' });
  postToPopup({ action: 'preloadDone' });
  isPreloading = false;
}


// ── Per-patient preload ──
async function preloadPatient(pt, serverUrl, clinicDate, filters) {
  const result = await sendToContentScript('searchPatient', {
    name: pt.name,
    dob: pt.dob,
    filters,
  });

  if (result.error) {
    postToPopup({ action: 'preloadLog', text: `  ✗ Search error: ${result.error}`, cls: 'error' });
    await registerPatientPlaceholder(pt, serverUrl, clinicDate);
    return 0;
  }
  if (!result.studies || result.studies.length === 0) {
    postToPopup({ action: 'preloadLog', text: `  ✗ No studies found — adding to viewer for manual refresh`, cls: 'error' });
    await registerPatientPlaceholder(pt, serverUrl, clinicDate);
    return 0;
  }

  postToPopup({ action: 'preloadLog', text: `  Found ${result.studies.length} study(ies)`, cls: 'success' });
  let count = 0;

  for (const study of result.studies) {
    postToPopup({ action: 'preloadLog', text: `  ${study.description || 'Unknown study'}`, cls: 'info' });
    if (!study.series || study.series.length === 0) {
      postToPopup({ action: 'preloadLog', text: `    No series found`, cls: 'error' });
      continue;
    }

    const sent = await sendToContentScript('batchPreloadStudy', {
      studyUid:         study.studyUid,
      series:           study.series,
      patient:          { name: pt.name, dob: pt.dob, provider: pt.provider || '' },
      studyDescription: study.description || '',
      studyDate:        study.studyDate || '',
      serverUrl,
      clinicDate,
    });

    if (sent.error) { postToPopup({ action: 'preloadLog', text: `    ✗ ${sent.error}`, cls: 'error' }); continue; }
    count += sent.count || 0;
    if (sent.studyDate) postToPopup({ action: 'preloadLog', text: `    Study date: ${sent.studyDate}`, cls: 'info' });
    postToPopup({ action: 'preloadLog', text: `    ✓ ${sent.count} image(s) from ${study.series.length} series`, cls: 'success' });
  }
  return count;
}

async function registerPatientPlaceholder(pt, serverUrl, clinicDate) {
  try {
    const form = new FormData();
    form.append('patient_name', pt.name);
    form.append('patient_dob', pt.dob);
    form.append('clinic_date', clinicDate);
    form.append('provider', pt.provider || '');
    await fetch(`${serverUrl}/api/patients/register`, { method: 'POST', body: form });
  } catch (e) { /* non-critical */ }
}


// ── Pending Refresh Poll ──
async function pollPendingRefreshes() {
  if (isPreloading) return;
  console.log('[Refresh] poll fired — pacsTabId:', pacsTabId);

  // Recover pacsTabId if service worker restarted (in-memory state lost)
  if (!pacsTabId) {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    console.log('[Refresh] all tabs:', allTabs.map(t => t.id + ' ' + t.url));
    const pacsTabs = allTabs.filter(t => t.url && t.url.includes('pacs.renoortho.com'));
    console.log('[Refresh] PACS tabs found:', pacsTabs.length);
    if (!pacsTabs.length) { console.log('[Refresh] no PACS tab — aborting'); return; }
    pacsTabId = pacsTabs[0].id;
    console.log('[Refresh] recovered pacsTabId:', pacsTabId);
  }

  try {
    const saved = await chrome.storage.local.get(['serverUrl', 'clinicDate']);
    const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');
    console.log('[Refresh] serverUrl:', serverUrl);
    const clinicDate = saved.clinicDate || '';
    // Refreshes only fetch new X-rays — fast targeted lookup
    const baseFilters = await getFiltersFromStorage();
    const filters = { ...baseFilters, modalities: ['xr'] };

    const resp = await fetch(`${serverUrl}/api/pending_refreshes`);
    if (!resp.ok) { console.log('[Refresh] pending_refreshes returned', resp.status); return; }
    const data = await resp.json();
    const pendingKeys = Object.keys(data.pending || {});
    console.log('[Refresh] pending keys:', pendingKeys);

    for (const [key] of Object.entries(data.pending || {})) {
      if (refreshesInProgress.has(key)) { console.log('[Refresh] already in progress:', key); continue; }

      // Try in-memory list first; fall back to server lookup (handles service worker restart)
      let patient = scheduledPatients.find(p => buildPatientKey(p) === key);
      if (!patient) {
        console.log('[Refresh] patient not in memory — fetching from server:', key);
        try {
          const pr = await fetch(`${serverUrl}/api/patients/${encodeURIComponent(key)}`);
          console.log('[Refresh] patient fetch status:', pr.status);
          if (!pr.ok) continue;
          const pd = await pr.json();
          patient = { name: pd.name, dob: pd.dob, provider: pd.provider || '', clinic_date: pd.clinic_date || '' };
          console.log('[Refresh] patient from server:', patient.name);
        } catch (e) { console.log('[Refresh] patient fetch error:', e.message); continue; }
      }

      refreshesInProgress.add(key);
      postToPopup({ action: 'preloadLog', text: `Auto-refreshing: ${patient.name}`, cls: 'info' });
      console.log('[Refresh] starting preloadPatient for', patient.name);
      try {
        const ptClinicDate = clinicDate || patient.clinic_date || '';
        await preloadPatient(patient, serverUrl, ptClinicDate, filters);
        await fetch(`${serverUrl}/api/pending_refreshes/${encodeURIComponent(key)}`, { method: 'DELETE' });
        console.log('[Refresh] done + cleared pending for', patient.name);
      } catch (e) {
        console.log('[Refresh] preloadPatient error:', e.message);
        postToPopup({ action: 'preloadLog', text: `  ✗ Refresh error: ${e.message}`, cls: 'error' });
      }
      refreshesInProgress.delete(key);
    }
  } catch (e) { console.log('[Refresh] outer error:', e.message); }
}

async function getFiltersFromStorage() {
  const saved = await chrome.storage.local.get(['filterSpine', 'filterXR', 'filterCT', 'filterMR']);
  const spineRegions = saved.filterSpine !== false ? ['lumbar', 'cervical', 'thoracic'] : null;
  const modalities = [];
  if (saved.filterXR !== false) modalities.push('xr');
  if (saved.filterCT) modalities.push('ct');
  if (saved.filterMR) modalities.push('mr');
  return { spineRegions, modalities: modalities.length > 0 ? modalities : null };
}


// ── Helpers ──
function buildPatientKey(pt) {
  const combined = `${pt.name}_${pt.dob}`;
  return combined.replace(/[^\w\s\-.]/g, '').replace(/\s+/g, '_').slice(0, 100);
}

async function sendToContentScript(action, data) {
  try {
    return await _sendTabMessage(pacsTabId, action, data);
  } catch (e) {
    if (e.message.includes('Receiving end does not exist')) {
      // Content script not loaded (tab opened before extension, or SW restarted).
      // Inject it now and retry once.
      console.log('[Refresh] content script missing — injecting into tab', pacsTabId);
      await chrome.scripting.executeScript({ target: { tabId: pacsTabId }, files: ['content.js'] });
      await sleep(400);
      return await _sendTabMessage(pacsTabId, action, data);
    }
    throw e;
  }
}

function _sendTabMessage(tabId, action, data) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action, ...data }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
