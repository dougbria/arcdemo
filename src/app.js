/* ============================================================
   app.js — Main application controller
   Wires together all modules and event handlers.
   ============================================================ */

import state from './state.js';
import api from './api.js';
import { initCanvas } from './canvas.js';
import { initGallery } from './gallery.js';
import { initCompare } from './compare.js';
import { initResizers } from './resizer.js';
import {
    createThumbnail,
    generateUUID,
    findDiffPaths,
    copyToClipboard,
    downloadPNG,
    downloadJSON,
    downloadTxt,
    generateFilename,
    generateTxtFilename,
    generateTxtReport,
    fileToBase64,
    showToast,
    pickExportFolder,
    writeFilesToHandle,
    saveFilesToFolder
} from './utils.js';
import { enhanceImage } from './actions.js';
import { renderJsonTree, transformStructuredPrompt } from './json-viewer.js';
import { fsStorage } from './fs-storage.js';
import JSZip from 'jszip';


// ---- Critical Error Monitoring ----
window.addEventListener('error', (e) => {
    console.error('[GLOBAL ERROR]:', e.error || e.message);
    showToast('App Crash: ' + (e.message || 'Check console'), 5000);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[UNHANDLED REJECTION]:', e.reason);
    showToast('Async Error: ' + (e.reason?.message || 'Check console'), 5000);
});

// ============================================================
// STRUCTURED PROMPT PASSTHROUGH DETECTION
// ============================================================

/**
 * The minimum set of top-level keys required to treat a JSON object
 * as a pre-formed structured prompt (per the SP schema).
 */
const SP_REQUIRED_KEYS = [
    'short_description',
    'objects',
    'lighting',
    'aesthetics',
    'photographic_characteristics'
];

/**
 * Try to parse `text` as a structured prompt JSON.
 * Returns the parsed object if it matches the schema requirements,
 * or null if it's not a valid / recognised SP JSON.
 *
 * @param {string} text
 * @returns {Object|null}
 */
function parseAsStructuredPrompt(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return null; // fast-exit for plain prompts
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const hasAllRequired = SP_REQUIRED_KEYS.every(k => Object.prototype.hasOwnProperty.call(parsed, k));
        return hasAllRequired ? parsed : null;
    } catch {
        return null; // not valid JSON
    }
}

// ---- DOM Elements ----
const getEl = (id) => {
    const el = document.getElementById(id);
    if (!el) console.warn(`[DOM] Element not found: #${id}`);
    return el;
};

// Main Elements
const projectSelect = getEl('project-select');
const newProjectBtn = getEl('new-project-btn');
const deleteProjectBtn = getEl('delete-project-btn');
const newProjectDialog = getEl('new-project-dialog');
const newProjectName = getEl('new-project-name');
const welcomeNewBtn = getEl('welcome-new-btn');
const apiKeyInput = getEl('api-key-input');
const apiKeyToggle = getEl('api-key-toggle');

// JSON Sidebar Elements
const spSidebar = getEl('json-sidebar');
const jsonViewMode = getEl('json-view-mode');
const jsonSidebarClose = getEl('json-sidebar-close');
const jsonInspectorPre = getEl('json-inspector-pre');
const jsonInspectorTree = getEl('json-inspector-tree');
const jsonSidebarHeaderToggle = getEl('json-sidebar-header-toggle');

const promptInput = getEl('prompt-input');
const negativePromptInput = getEl('negative-prompt-input');
const imageCountSelect = getEl('image-count-select');
const aspectRatioSelect = getEl('aspect-ratio-select');
const resolutionSelect = getEl('resolution-select');
const seedInput = getEl('seed-input');

const liteModeToggle = getEl('lite-mode-toggle');
const modContentToggle = getEl('mod-content-toggle');
const modInputToggle = getEl('mod-input-toggle');
const modOutputToggle = getEl('mod-output-toggle');
const previewSpCheckbox = getEl('preview-sp-checkbox');

const imageUpload = getEl('image-upload');
const uploadBtnText = getEl('upload-btn-text');
const uploadPreviewWrap = getEl('upload-preview-wrap');
const uploadPreview = getEl('upload-preview');
const clearUploadBtn = getEl('clear-upload-btn');

const btnGenerate = getEl('btn-generate');
const btnRefine = getEl('btn-refine');
const btnEdit = getEl('btn-edit');
const actionButtonsStack = getEl('action-buttons-stack');
const btnInterrupt = getEl('btn-interrupt');
const progressText = btnInterrupt ? btnInterrupt.querySelector('.progress-text') : null;

const refIndicator = getEl('ref-indicator');

const retryBtn = getEl('retry-btn');
const infoSeed = getEl('info-seed');
const infoPrompt = getEl('info-prompt');


const spToggle = getEl('sp-toggle');
const spContent = getEl('sp-content');
const spJson = getEl('sp-json');
const spToggleIcon = spToggle ? spToggle.querySelector('.vgl-toggle-icon') : null;

const spPreviewDialog = getEl('sp-preview-dialog');
const spPreviewEditor = getEl('sp-preview-editor');
const spPreviewGenerate = getEl('sp-preview-generate');
const spPreviewCancel = getEl('sp-preview-cancel');

// API Key Warning Dialog
const apiKeyWarningDialog = getEl('api-key-warning-dialog');
const apiKeyWarningGo = getEl('api-key-warning-go');
const apiKeyWarningClose = getEl('api-key-warning-close');

apiKeyWarningGo?.addEventListener('click', () => {
    apiKeyWarningDialog?.close();
    const advanced = document.querySelector('.prompt-advanced-details');
    if (advanced) advanced.open = true;
    apiKeyInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    apiKeyInput?.focus();
});
apiKeyWarningClose?.addEventListener('click', () => apiKeyWarningDialog?.close());

// Logs Panel
const logsPanel = getEl('logs-panel');
const logsToggle = getEl('logs-toggle');
const logsContent = getEl('logs-content');
const logsList = getEl('logs-list');
const logsClearBtn = getEl('logs-clear-btn');
const logsToggleIcon = logsToggle ? logsToggle.querySelector('.vgl-toggle-icon') : null;

const exportStarredBtn = getEl('export-starred-btn');

let uploadedImageBase64 = null;
let currentAbortController = null;

// ============================================================
// INITIALIZATION
// ============================================================

(async function startup() {
    console.log('[APP] Starting initialization...');
    await state.init();
    console.log('[APP] State initialized');

    initCanvas();
    initGallery();
    initCompare();
    initResizers([
        { resizerId: 'resizer-gallery', prevId: 'canvas-area', nextId: 'reel-sidebar', mode: 'horizontal' },
        { resizerId: 'resizer-json', prevId: 'reel-sidebar', nextId: 'json-sidebar', mode: 'horizontal' }
    ]);
    console.log('[APP] Modules initialized');

    loadApiKey();
    updateStorageUI();
    populateProjectSelect();
    updateActionButtonsState();

    console.log('[APP] VGL Studio initialized (Bria API refactored)');
})();

// ============================================================
// STORAGE SETUP UI
// ============================================================

const storageBanner = document.getElementById('storage-banner');
const storageBannerTitle = document.getElementById('storage-banner-title');
const storageBannerDesc = document.getElementById('storage-banner-desc');
const storagePickBtn = document.getElementById('storage-pick-btn');
const storageSkipBtn = document.getElementById('storage-skip-btn');
const storageBannerClose = document.getElementById('storage-banner-close');
const storageIndicatorBtn = document.getElementById('storage-indicator-btn');
const storageIndicatorName = document.getElementById('storage-indicator-name');

/**
 * Reflect the current storageType in the UI:
 *   'pending'  → show setup banner
 *   'fs'       → hide banner, show folder indicator in header
 *   'ls'       → hide banner, hide indicator
 */
function updateStorageUI() {
    if (!storageBanner) return;

    const type = state.storageType;

    if (type === 'pending') {
        if (storageBannerTitle) storageBannerTitle.textContent = 'Set up persistent storage';
        if (storageBannerDesc) storageBannerDesc.textContent = 'Choose a local folder to save your projects & images across sessions.';
        if (storagePickBtn) storagePickBtn.textContent = 'Choose Folder';
        storageBanner.classList.remove('hidden');
        storageIndicatorBtn?.classList.add('hidden');
    } else if (type === 'fs') {
        storageBanner.classList.add('hidden');
        if (storageIndicatorBtn && storageIndicatorName) {
            storageIndicatorName.textContent = fsStorage.getFolderName() || 'Local Folder';
            storageIndicatorBtn.classList.remove('hidden');
        }
    } else {
        // localStorage mode — no banner, no indicator
        storageBanner.classList.add('hidden');
        storageIndicatorBtn?.classList.add('hidden');
    }
}

// After the FS folder is chosen
state.on('storageReady', () => {
    updateStorageUI();
    populateProjectSelect();
    updateActionButtonsState();
});

// "Choose Folder" button
storagePickBtn?.addEventListener('click', async () => {
    storagePickBtn.disabled = true;
    storagePickBtn.textContent = 'Opening…';
    const ok = await state.setupStorage();
    storagePickBtn.disabled = false;
    storagePickBtn.textContent = 'Choose Folder';
    if (!ok) showToast('No folder selected — try again.');
});

// "Use Browser Storage" button
storageSkipBtn?.addEventListener('click', async () => {
    await state.skipToLocalStorage();
    updateStorageUI();
});

// Dismiss (X) — hides the banner this session only
storageBannerClose?.addEventListener('click', () => {
    storageBanner.classList.add('hidden');
});

// Header folder indicator — clicking lets the user change the folder
storageIndicatorBtn?.addEventListener('click', async () => {
    if (!confirm('Change your storage folder? Your current projects will remain in the old folder.')) return;
    const ok = await state.setupStorage();
    if (ok) {
        updateStorageUI();
        showToast('✓ Storage folder updated.');
    }
});

// ============================================================
// PROJECT MANAGEMENT
// ============================================================

function populateProjectSelect() {
    const projects = state.getProjectList();
    const activeId = state.activeProjectId;

    projectSelect.innerHTML = '<option value="">— Select Project —</option>';
    projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const displayName = p.name.length > 40 ? p.name.substring(0, 40) + '...' : p.name;
        opt.textContent = `${displayName} (${p.imageCount})`;
        if (p.id === activeId) opt.selected = true;
        projectSelect.appendChild(opt);
    });
}

projectSelect.addEventListener('change', () => {
    const id = projectSelect.value;
    if (id) {
        state.switchProject(id);
        updateJsonInspector();
    }
});

newProjectBtn.addEventListener('click', openNewProjectDialog);
welcomeNewBtn.addEventListener('click', openNewProjectDialog);

function openNewProjectDialog() {
    if (!newProjectDialog) return;
    newProjectName.value = '';
    if (newProjectDialog.showModal) {
        newProjectDialog.showModal();
    } else {
        newProjectDialog.setAttribute('open', '');
    }
}

newProjectDialog.addEventListener('close', async () => {
    if (newProjectDialog.returnValue === 'create' && newProjectName.value.trim()) {
        await state.createProject(newProjectName.value.trim());
        populateProjectSelect();
    }
});

if (deleteProjectBtn) deleteProjectBtn.addEventListener('click', async () => {
    const project = state.getActiveProject();
    if (!project) return;
    if (confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
        await state.deleteProject(project.id);
        populateProjectSelect();
    }
});

if (exportStarredBtn) exportStarredBtn.onclick = async () => {
    if (exportStarredBtn.dataset.exporting) return;
    exportStarredBtn.dataset.exporting = '1';
    exportStarredBtn.disabled = true;

    try {
        const project = state.getActiveProject();
        const starredImages = project?.images.filter(img => img.isStarred) || [];

        if (!starredImages.length) {
            showToast('No starred images in this project to export.');
            return;
        }

        /** Return full base64 for an image — loads from disk in FS mode. */
        async function resolveBase64(img) {
            if (img.base64) return img.base64;
            if (state.storageType === 'fs') {
                const b64 = await fsStorage.loadImage(project.id, img.id);
                if (b64) return b64;
            }
            return null;
        }

        showToast(`Preparing ${starredImages.length} image${starredImages.length > 1 ? 's' : ''}…`);

        // Build a zip with all starred images + sidecar files
        const zip = new JSZip();
        let count = 0;

        for (const img of starredImages) {
            const base = generateFilename(img, project.name, project);
            const txtBase = generateTxtFilename(img, project.name, project);
            const b64 = await resolveBase64(img);
            if (!b64) continue;

            // PNG — strip data URL header and decode to binary
            const raw = b64.replace(/^data:image\/\w+;base64,/, '');
            zip.file(base + '.png', raw, { base64: true });

            // VGL JSON sidecar
            if (img.structured_prompt) {
                let spObj;
                try { spObj = typeof img.structured_prompt === 'string' ? JSON.parse(img.structured_prompt) : img.structured_prompt; }
                catch { spObj = img.structured_prompt; }
                zip.file(base + '.json', JSON.stringify(spObj, null, 2));
            }

            // Text report
            zip.file(txtBase + '.txt', generateTxtReport(img, project));
            count++;
        }

        if (!count) { showToast('⚠️ Could not load any images to export.'); return; }

        // Generate zip blob and trigger single download
        const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
        const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const zipFilename = `${projectSlug}_starred_${ts}.zip`;

        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(zipBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = zipFilename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 2000);

        showToast(`✓ Downloaded ${count} image${count !== 1 ? 's' : ''} as ${zipFilename}`);
    } finally {
        delete exportStarredBtn.dataset.exporting;
        exportStarredBtn.disabled = false;
    }
};

// Clear Starred button
const clearStarredBtn = document.getElementById('clear-starred-btn');
if (clearStarredBtn) clearStarredBtn.addEventListener('click', () => {
    const project = state.getActiveProject();
    const starred = project?.images.filter(img => img.isStarred) || [];
    if (!starred.length) {
        showToast('No starred images to clear.');
        return;
    }
    if (!confirm(`Unstar all ${starred.length} starred image${starred.length > 1 ? 's' : ''}?`)) return;
    starred.forEach(img => state.toggleStar(img.id));
    showToast(`Unstarred ${starred.length} image${starred.length > 1 ? 's' : ''}.`);
});



state.on('projectChanged', () => {
    populateProjectSelect();
    updateActionButtonsState();
    updateJsonInspector();
    updateHeaderToggleState();
    updateStarredCount();
});

state.on('imagesChanged', () => {
    updateStarredCount();
});
state.on('imageStarred', () => {
    updateStarredCount();
});

function updateStarredCount() {
    const project = state.getActiveProject();
    if (!project) return;
    const count = project.images.filter(img => img.isStarred).length;
    const el = document.getElementById('starred-count');
    if (el) el.textContent = count;
}

function updateHeaderToggleState() {
    const isCollapsed = spSidebar?.classList.contains('collapsed');
    jsonSidebarHeaderToggle?.classList.toggle('active', !isCollapsed);
}

// ============================================================
// API KEY
// ============================================================

function loadApiKey() {
    const key = state.getApiKey();
    if (key) {
        apiKeyInput.value = key;
    }
}

apiKeyInput.addEventListener('input', () => {
    state.setApiKey(apiKeyInput.value);
    updateActionButtonsState();
});

jsonSidebarClose?.addEventListener('click', () => {
    spSidebar.classList.add('collapsed');
    jsonSidebarClose.textContent = '◀';
    updateHeaderToggleState();
});

jsonSidebarHeaderToggle?.addEventListener('click', () => {
    const isCollapsed = spSidebar.classList.toggle('collapsed');
    if (jsonSidebarClose) {
        jsonSidebarClose.textContent = isCollapsed ? '◀' : '▶';
    }
    updateHeaderToggleState();
    // Re-render whenever the sidebar becomes visible in case it was hidden during a selection
    if (!isCollapsed) {
        updateJsonInspector();
    }
});

jsonViewMode?.addEventListener('change', updateJsonInspector);

apiKeyToggle.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    apiKeyToggle.textContent = isPassword ? '🙈' : '👁';
});

// ============================================================
// ACTION BUTTONS STATE
// ============================================================

promptInput.addEventListener('input', updateActionButtonsState);

function updateActionButtonsState() {
    const hasProject = !!state.getActiveProject();
    const hasApiKey = !!state.getApiKey();
    const hasPrompt = promptInput.value.trim().length > 0;
    const hasFeatured = !!state.getFeaturedImage();

    // Project is a hard requirement for UI logic
    if (!hasProject) {
        btnGenerate.disabled = true;
        btnRefine.disabled = true;
        btnEdit.disabled = true;
        return;
    }

    // Always enable Generate/Refine/Edit if we have a project,
    // so we can give constructive feedback on click if API key or Prompt is missing.
    btnGenerate.disabled = false;
    btnRefine.disabled = false;
    btnEdit.disabled = false;

    // Visual cues only
    btnGenerate.classList.toggle('dimmed', !hasPrompt || !hasApiKey);
    btnRefine.classList.toggle('dimmed', !hasPrompt || !hasApiKey || !hasFeatured);
    btnEdit.classList.toggle('dimmed', !hasPrompt || !hasApiKey || (!hasFeatured && !uploadedImageBase64));

    // Update Reference Indicator visibility
    if (hasFeatured) {
        const featured = state.getFeaturedImage();
        refIndicator.classList.toggle('hidden', !featured.isReference);
    } else {
        refIndicator.classList.add('hidden');
    }
}

state.on('featuredChanged', () => {
    updateActionButtonsState();
    updateJsonInspector();

    // Auto-populate seed if empty
    const featured = state.getFeaturedImage();
    if (featured && !seedInput.value.trim()) {
        seedInput.value = featured.seed;
    }
});

// ============================================================
// IMAGE UPLOAD
// ============================================================

imageUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadedImageBase64 = await fileToBase64(file);
    uploadPreview.src = uploadedImageBase64;
    uploadPreviewWrap.classList.remove('hidden');
    uploadBtnText.textContent = '✓';
    updateActionButtonsState();
});

clearUploadBtn.addEventListener('click', () => {
    uploadedImageBase64 = null;
    imageUpload.value = '';
    uploadPreview.src = '';
    uploadPreviewWrap.classList.add('hidden');
    uploadBtnText.textContent = '📎';
    updateActionButtonsState();
});

// ---- Interrupt ----
if (btnInterrupt) {
    btnInterrupt.addEventListener('click', () => {
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
            state.setLoading(false);
            showToast('Processing interrupted');
        }
    });
}

// ============================================================
// SUBMIT ACTIONS (Generate / Refine / Edit)
// ============================================================

// ---- Submit Actions ----
if (btnGenerate) btnGenerate.addEventListener('click', () => handleAction('generate'));
if (btnRefine) btnRefine.addEventListener('click', () => handleAction('refine'));
if (btnEdit) btnEdit.addEventListener('click', () => handleAction('edit'));

if (promptInput) {
    promptInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            if (btnGenerate && !btnGenerate.disabled) handleAction('generate');
            else if (btnRefine && !btnRefine.disabled) handleAction('refine');
            else if (btnEdit && !btnEdit.disabled) handleAction('edit');
        }
    });
}

/**
 * Gather common generation options from the UI.
 */
function getGenerationOptions() {
    return {
        aspect_ratio: aspectRatioSelect.value || undefined,
        resolution: resolutionSelect.value === '4MP' ? '4MP' : undefined,
        negative_prompt: negativePromptInput.value.trim() || undefined,
        lite: !!liteModeToggle.checked,
        mod_content: !!modContentToggle.checked,
        mod_input: !!modInputToggle.checked,
        mod_output: !!modOutputToggle.checked,
        ip_signal: !!document.getElementById('ip-signal-toggle').checked
    };
}

async function handleAction(mode) {
    const prompt = promptInput.value.trim();
    const hasApiKey = !!state.getApiKey();

    // Check API key first — this is the harder blocker to discover
    if (!hasApiKey) {
        const dlg = document.getElementById('api-key-warning-dialog');
        if (dlg?.showModal) dlg.showModal();
        else showToast('Bria API Token is missing. See Advanced Settings.');
        return;
    }

    if (!prompt) {
        showToast('Please enter a prompt or instructions.');
        promptInput.focus();
        return;
    }

    const imageCount = parseInt(imageCountSelect.value, 10);
    const options = getGenerationOptions();
    const seed = seedInput.value.trim() ? parseInt(seedInput.value.trim(), 10) : null;

    console.log(`[handleAction] START - Mode: ${mode}, Count: ${imageCount}, Prompt: "${prompt}"`, options);

    try {
        const featured = state.getFeaturedImage();

        if ((mode === 'refine' || mode === 'edit') && !featured && !uploadedImageBase64) {
            showToast(`Please select an image in the gallery to ${mode}.`);
            return;
        }

        if (previewSpCheckbox.checked && (mode === 'generate' || mode === 'edit' || mode === 'refine')) {
            console.log('[handleAction] Redirecting to Preview SP');
            await handleStructuredPromptPreview(prompt, imageCount, options, mode);
            return;
        }

        let editImage = uploadedImageBase64 || (mode === 'edit' ? featured?.base64 : null);
        let parentImageId = (mode === 'refine' || mode === 'edit') ? featured?.id : null;
        let batchId = generateUUID();

        // --- Workflow 1: Upload Registration ---
        if (mode === 'edit' && uploadedImageBase64) {
            state.setLoading(true, 'Registering upload…');
            const thumb = await createThumbnail(uploadedImageBase64, 200);
            const refImg = await state.addImage({
                base64: uploadedImageBase64,
                thumbnail: thumb,
                isReference: true
            }, prompt, 'upload', batchId);
            parentImageId = refImg.id;
        }

        state.lastPrompt = prompt;
        state.clearError();
        state.setLoading(true, `${mode.charAt(0).toUpperCase() + mode.slice(1).replace(/e$/, '')}ing…`);

        // Interruption & Progress UI
        currentAbortController = new AbortController();
        if (actionButtonsStack) actionButtonsStack.classList.add('hidden');
        if (btnInterrupt) btnInterrupt.classList.remove('hidden');

        // --- PRE-CALCULATE STRUCTURED PROMPT FOR BATCH ---
        let batchStructuredPrompt = null;
        if (mode === 'generate') {
            // Check if the prompt is itself a pre-formed SP JSON — if so, skip the API call
            const directSp = parseAsStructuredPrompt(prompt);
            if (directSp) {
                console.log('[TRACE] handleAction - prompt is a structured prompt JSON, skipping SP generation');
                showToast('Using structured prompt directly — skipping layout generation.', 3000);
                batchStructuredPrompt = directSp;
            } else {
                console.log('[TRACE] handleAction - mode is generate, calling generateStructuredPrompt');
                state.setLoading(true, 'Generating layout…');
                const spResult = await api.generateStructuredPrompt(prompt, uploadedImageBase64, null, options);
                console.log('[TRACE] handleAction - generateStructuredPrompt returned', { sp: !!spResult.structured_prompt });
                batchStructuredPrompt = spResult.structured_prompt;
                if (!batchStructuredPrompt) throw new Error('Failed to generate structured prompt.');
            }
        } else if (mode === 'refine') {
            console.log('[TRACE] handleAction - mode is refine, usando existing SP');
            // Use featured image's SP (parse if it's a string from storage)
            const rawSp = featured.structured_prompt;
            try {
                batchStructuredPrompt = typeof rawSp === 'string' ? JSON.parse(rawSp) : rawSp;
            } catch (e) {
                console.warn('[TRACE] handleAction - Error parsing existing SP', e);
                batchStructuredPrompt = rawSp;
            }
        }

        // Default Refine/Edit seed to featured seed if available
        const baseSeed = seed !== null ? seed : ((mode === 'refine' || mode === 'edit') && featured ? featured.seed : Math.floor(Math.random() * 2147483647));
        console.log('[TRACE] handleAction - entering loop', { imageCount, baseSeed });
        const batchResults = [];
        for (let i = 0; i < imageCount; i++) {
            console.log(`[TRACE] handleAction - loop iteration ${i + 1}/${imageCount}`);
            if (currentAbortController?.signal.aborted) {
                console.warn('[TRACE] handleAction - loop aborted');
                break;
            }

            const currentSeed = baseSeed + i;
            const statusMsg = `${mode.charAt(0).toUpperCase() + mode.slice(1).replace(/e$/, '')}ing ${i + 1}/${imageCount}…`;
            state.setLoading(true, statusMsg);
            if (progressText) progressText.textContent = statusMsg;

            try {
                let result;
                switch (mode) {
                    case 'generate':
                    case 'refine':
                        result = await api.generate(prompt, currentSeed, null, {
                            ...options,
                            structured_prompt: batchStructuredPrompt
                        });
                        break;
                    case 'edit':
                        result = await api.edit(prompt, editImage, currentSeed, options);
                        break;
                }
                const thumbnail = await createThumbnail(result.base64, 200);

                // Incremental update — add to gallery and feature
                await state.addImage({ ...result, thumbnail }, prompt, mode, batchId, parentImageId);

                // After the first image arrives, lift the canvas overlay so the user
                // can view and interact with it while the remaining images generate.
                if (i === 0) state.setCanvasLoading(false);

                // Add a small 1s "breath" delay between images
                if (i < imageCount - 1) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (err) {
                console.error(`[handleAction] Item ${i + 1} failed:`, err);
            }
        }
    } catch (err) {
        if (err.name === 'AbortError' || err.message === 'Processing interrupted') {
            showToast('Generation interrupted');
        } else {
            console.error('[handleAction] ERROR:', err);
            const msg = err.message || 'An unexpected error occurred.';
            state.setError(msg);
            showToast('Error: ' + msg);
            promptInput.value = state.lastPrompt;
        }
    } finally {
        console.log('[handleAction] FINALLY - cleaning up');
        state.setLoading(false);
        btnInterrupt.classList.add('hidden');
        actionButtonsStack.classList.remove('hidden');
        currentAbortController = null;
    }
}

// ============================================================
// STRUCTURED PROMPT PREVIEW
// ============================================================

/**
 * Preview the structured prompt before generating.
 * Shows a dialog where the user can review/edit, then choose to generate or go back.
 */
async function handleStructuredPromptPreview(prompt, imageCount, options, mode = 'generate') {
    state.lastPrompt = prompt;
    state.clearError();
    state.setLoading(true, 'Generating preview…');

    try {
        const featured = state.getFeaturedImage();
        let spResult;
        let batchId = generateUUID();
        let parentImageId = (mode === 'refine' || mode === 'edit' ? featured?.id : null);
        const baseSeed = options.seed !== undefined ? options.seed : (featured ? featured.seed : Math.floor(Math.random() * 2147483647));

        if (mode === 'refine') {
            if (!featured) throw new Error('No image selected to refine.');
            spResult = {
                structured_prompt: featured.structured_prompt,
                seed: featured.seed
            };
        } else if (mode === 'edit') {
            const editImage = uploadedImageBase64 || featured?.base64;
            if (!editImage) throw new Error('Upload or select an image for edit.');

            if (uploadedImageBase64) {
                state.setLoading(true, 'Registering upload…');
                const thumb = await createThumbnail(uploadedImageBase64, 200);
                const refImg = await state.addImage({
                    base64: uploadedImageBase64,
                    thumbnail: thumb,
                    isReference: true
                }, prompt, 'upload', batchId);
                parentImageId = refImg.id;
            }

            // For natural language edit, we don't have a VGL "preview" per se, 
            // but we'll show the JSON structure that will be sent.
            spResult = {
                structured_prompt: JSON.stringify({
                    instruction: prompt,
                    seed: baseSeed
                }, null, 2)
            };
        }
        else {
            spResult = await api.generateStructuredPrompt(prompt, uploadedImageBase64, null, options);
        }

        state.setLoading(false);

        if (!spResult.structured_prompt) throw new Error('No structured prompt returned.');

        const originalSp = spResult.structured_prompt;

        // Format JSON
        let formatted;
        try {
            const parsed = typeof originalSp === 'string'
                ? JSON.parse(originalSp) : originalSp;
            formatted = JSON.stringify(parsed, null, 2);
        } catch {
            formatted = originalSp;
        }

        spPreviewEditor.value = formatted;
        spPreviewDialog.showModal();

        const action = await new Promise((resolve) => {
            const onGen = () => { cleanup(); resolve('generate'); };
            const onCancel = () => { cleanup(); resolve('cancel'); };
            function cleanup() {
                spPreviewGenerate.removeEventListener('click', onGen);
                spPreviewCancel.removeEventListener('click', onCancel);
                spPreviewDialog.close();
            }
            spPreviewGenerate.addEventListener('click', onGen);
            spPreviewCancel.addEventListener('click', onCancel);
        });

        if (action === 'generate') {
            let editedSp = spPreviewEditor.value.trim();
            const seedFromInput = seedInput.value.trim() ? parseInt(seedInput.value.trim(), 10) : null;

            // Refine/Edit seed defaults to featured image seed
            const startSeed = seedFromInput !== null ? seedFromInput : ((mode === 'refine' || mode === 'edit') && featured ? featured.seed : (spResult.seed || Math.floor(Math.random() * 2147483647)));

            const editImage = uploadedImageBase64 || (mode === 'edit' ? featured?.base64 : null);
            const parentId = parentImageId; // Use the one we prepared earlier (includes uploaded reference)

            // Optimization: If JSON was edited, call generate_from_diff
            let finalSp = editedSp;

            // Simple comparison of trimmed strings to see if edited
            if (editedSp !== formatted) {
                console.log('[SP] JSON edited, reconciling with original via diff...');
                state.setLoading(true, 'Optimizing structured prompt…');

                // For manual edits, if it's a gallery image, we reconcile against the source image's SP
                const baseSpForDiff = (mode === 'edit' && !uploadedImageBase64 && featured) ? featured.structured_prompt : originalSp;
                const diffResult = await api.generateStructuredPromptFromDiff(baseSpForDiff, editedSp, startSeed, options);
                finalSp = diffResult.structured_prompt || editedSp;
            }

            // Ensure finalSp is a parsed object if it's currently a string
            let parsedSp = finalSp;
            if (typeof finalSp === 'string') {
                try {
                    parsedSp = JSON.parse(finalSp);
                    console.log('[TRACE] handleStructuredPromptPreview - Parsed finalSp successfully');
                } catch (e) {
                    console.warn('[TRACE] [SP] Could not parse finalSp as JSON, sending as-is:', e);
                }
            }

            console.log('[TRACE] handleStructuredPromptPreview - entering loop', { imageCount, mode });
            state.setLoading(true, 'Generating batch from structured prompt…');
            currentAbortController = new AbortController();
            actionButtonsStack.classList.add('hidden');
            btnInterrupt.classList.remove('hidden');
            if (progressText) progressText.textContent = 'Generating batch…';

            for (let i = 0; i < imageCount; i++) {
                console.log(`[TRACE] handleStructuredPromptPreview - loop iteration ${i + 1}/${imageCount}`);
                if (currentAbortController?.signal.aborted) break;

                const statusMsg = `Generating image ${i + 1}/${imageCount}…`;
                state.setLoading(true, statusMsg);
                if (progressText) progressText.textContent = statusMsg;
                const currentSeed = startSeed + i;

                try {
                    let result;
                    if (mode === 'edit') {
                        result = await api.edit(prompt, editImage, currentSeed, {
                            ...options,
                            structured_instruction: parsedSp
                        });
                    } else {
                        result = await api.generate(prompt, currentSeed, null, {
                            ...options,
                            structured_prompt: parsedSp
                        });
                    }

                    const thumbnail = await createThumbnail(result.base64, 200);

                    // Incremental update
                    await state.addImage({ ...result, thumbnail }, prompt, mode, batchId, parentImageId);

                    // Lift canvas overlay after first image so the user can interact
                    if (i === 0) state.setCanvasLoading(false);

                    if (i < imageCount - 1) {
                        await new Promise(r => setTimeout(r, 1000));
                    }
                } catch (itemErr) {
                    console.error(`[SP Preview] Image ${i + 1} failed:`, itemErr);
                    showToast(`Image ${i + 1} failed: ${itemErr.message}`);
                    // Continue with the rest of the batch
                }
            }
        }
    } catch (err) {
        state.setError(err.message);
        showToast('Error: ' + err.message); // Explicitly show toast
    } finally {
        state.setLoading(false);
        btnInterrupt.classList.add('hidden');
        actionButtonsStack.classList.remove('hidden');
        currentAbortController = null;
    }
}

// Retry button
retryBtn.addEventListener('click', () => {
    state.clearError();
    promptInput.value = state.lastPrompt;
    // Default to generate if we can't determine the last mode
    handleAction('generate');
});

// ============================================================
// IMAGE INFO BAR (copy actions)
// ============================================================

// ============================================================
// IMAGE INFO BAR (copy/download actions)
// ============================================================

infoSeed.addEventListener('click', () => {
    const img = state.getFeaturedImage();
    if (img) copyToClipboard(String(img.seed), 'Seed copied!');
});

infoPrompt.addEventListener('click', () => {
    const img = state.getFeaturedImage();
    if (img) copyToClipboard(img.prompt || '', 'Prompt copied!');
});

// ============================================================
// GALLERY NAVIGATION (canvas footer arrows)
// ============================================================

function navScrollToImage(imageId) {
    const el = document.getElementById('reel-scroll')?.querySelector(`[data-image-id="${imageId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('nav-prev')?.addEventListener('click', () => {
    const project = state.getActiveProject();
    if (!project?.images?.length) return;
    const ids = project.images.map(i => i.id);
    const cur = ids.indexOf(state.featuredImageId);
    const nextIdx = cur <= 0 ? ids.length - 1 : cur - 1;
    state.setFeaturedImage(ids[nextIdx]);
    navScrollToImage(ids[nextIdx]);
});

document.getElementById('nav-next')?.addEventListener('click', () => {
    const project = state.getActiveProject();
    if (!project?.images?.length) return;
    const ids = project.images.map(i => i.id);
    const cur = ids.indexOf(state.featuredImageId);
    const nextIdx = cur >= ids.length - 1 ? 0 : cur + 1;
    state.setFeaturedImage(ids[nextIdx]);
    navScrollToImage(ids[nextIdx]);
});

document.getElementById('nav-jump-parent')?.addEventListener('click', () => {
    const img = state.getFeaturedImage();
    if (!img?.parentImageId) { showToast('No parent image.'); return; }
    state.setFeaturedImage(img.parentImageId);
    navScrollToImage(img.parentImageId);
});

document.getElementById('nav-jump-child')?.addEventListener('click', () => {
    const project = state.getActiveProject();
    if (!project) return;
    const images = project.images;

    // All direct children of the current image
    const children = images.filter(i => i.parentImageId === state.featuredImageId);
    if (!children.length) { showToast('No child/variant images.'); return; }

    // Prefer a child that itself has children (keeps traversal going)
    const childWithKids = children.find(c => images.some(i => i.parentImageId === c.id));
    const target = childWithKids || children[0];

    state.setFeaturedImage(target.id);
    navScrollToImage(target.id);
});



// ============================================================
// STRUCTURED PROMPT PANEL
// ============================================================

if (spToggle && spContent && spToggleIcon) {
    spToggle.addEventListener('click', () => {
        const isOpen = !spContent.classList.contains('hidden');
        spContent.classList.toggle('hidden');
        spToggleIcon.classList.toggle('open', !isOpen);
    });
}

function updateJsonInspector() {
    const img = state.getFeaturedImage();
    if (!img || !img.structured_prompt) {
        jsonInspectorPre.textContent = '(no structured prompt data)';
        jsonInspectorTree.innerHTML = '';
        return;
    }

    let parsed;
    try {
        parsed = typeof img.structured_prompt === 'string'
            ? JSON.parse(img.structured_prompt) : img.structured_prompt;
    } catch (e) {
        jsonInspectorPre.textContent = 'Error parsing VGL data: ' + e.message;
        return;
    }

    const viewMode = jsonViewMode.value; // 'raw' or 'tree'

    if (viewMode === 'raw') {
        jsonInspectorPre.classList.remove('hidden');
        jsonInspectorTree.classList.add('hidden');
        jsonInspectorPre.textContent = JSON.stringify(parsed, null, 2);
    } else {
        jsonInspectorPre.classList.add('hidden');
        jsonInspectorTree.classList.remove('hidden');

        let highlightPaths = [];
        // Only highlight if it's a refinement
        if (img.mode === 'refine' && img.parentImageId) {
            const parent = state.getImage(img.parentImageId);
            if (parent && parent.structured_prompt) {
                try {
                    const parentParsed = typeof parent.structured_prompt === 'string'
                        ? JSON.parse(parent.structured_prompt) : parent.structured_prompt;
                    // Diff the TRANSFORMED versions so paths match what the tree actually renders
                    // e.g. "Aesthetics.color_scheme" not "aesthetics.color_scheme"
                    const transformedParent = transformStructuredPrompt(parentParsed);
                    const transformedChild = transformStructuredPrompt(parsed);
                    highlightPaths = findDiffPaths(transformedParent, transformedChild);
                } catch (e) {
                    console.warn('[JSON] Could not compute diff paths:', e);
                }
            }
        }
        renderJsonTree(transformStructuredPrompt(parsed), jsonInspectorTree, highlightPaths);
    }
}

state.on('featuredChanged', updateJsonInspector);

// ============================================================
// VGL INSPECTOR FOOTER — Copy All + Copy Part
// ============================================================

const vglCopyAllBtn = document.getElementById('vgl-copy-all-btn');
const vglCopyPartBtn = document.getElementById('vgl-copy-part-btn');
const vglCopyPartMenu = document.getElementById('vgl-copy-part-menu');

/** Return the parsed SP object for the featured image, or null. */
function getFeaturedSp() {
    const img = state.getFeaturedImage();
    if (!img?.structured_prompt) return null;
    try {
        return typeof img.structured_prompt === 'string'
            ? JSON.parse(img.structured_prompt) : img.structured_prompt;
    } catch { return null; }
}

/** Copy full SP JSON to clipboard. */
if (vglCopyAllBtn) {
    vglCopyAllBtn.addEventListener('click', () => {
        const sp = getFeaturedSp();
        if (!sp) { showToast('No VGL data for this image.'); return; }
        copyToClipboard(JSON.stringify(sp, null, 2), 'Full VGL copied!');
    });
}

/** Build Copy Part menu from the current SP. */
function buildCopyPartMenu() {
    if (!vglCopyPartMenu) return;
    vglCopyPartMenu.innerHTML = '';

    const sp = getFeaturedSp();
    if (!sp) {
        const empty = document.createElement('div');
        empty.className = 'vgl-menu-section';
        empty.textContent = 'No image selected';
        vglCopyPartMenu.appendChild(empty);
        return;
    }

    // ── Objects section ───────────────────────────────────
    const objects = Array.isArray(sp.objects) ? sp.objects : [];
    if (objects.length) {
        const objHeader = document.createElement('div');
        objHeader.className = 'vgl-menu-section';
        objHeader.textContent = 'Objects';
        vglCopyPartMenu.appendChild(objHeader);

        objects.forEach((obj, i) => {
            // Use first ~40 chars of description, or fallback to index
            const label = obj.description
                ? obj.description.replace(/\s+/g, ' ').trim().slice(0, 42) + (obj.description.length > 42 ? '…' : '')
                : `Object ${i + 1}`;

            const btn = document.createElement('button');
            btn.className = 'vgl-menu-item';
            btn.title = obj.description || `Object ${i + 1}`;
            btn.textContent = label;
            btn.addEventListener('click', () => {
                copyToClipboard(JSON.stringify(obj, null, 2), `Object copied!`);
                vglCopyPartMenu.classList.remove('open');
            });
            vglCopyPartMenu.appendChild(btn);
        });
    }

    // ── Background section ────────────────────────────────
    if (sp.background_setting) {
        const bgHeader = document.createElement('div');
        bgHeader.className = 'vgl-menu-section';
        bgHeader.textContent = 'Background';
        vglCopyPartMenu.appendChild(bgHeader);

        const bgBtn = document.createElement('button');
        bgBtn.className = 'vgl-menu-item';
        bgBtn.textContent = sp.background_setting.slice(0, 52) + (sp.background_setting.length > 52 ? '…' : '');
        bgBtn.title = sp.background_setting;
        bgBtn.addEventListener('click', () => {
            copyToClipboard(sp.background_setting, 'Background copied!');
            vglCopyPartMenu.classList.remove('open');
        });
        vglCopyPartMenu.appendChild(bgBtn);
    }

    if (!objects.length && !sp.background_setting) {
        const empty = document.createElement('div');
        empty.className = 'vgl-menu-section';
        empty.textContent = 'Nothing to copy';
        vglCopyPartMenu.appendChild(empty);
    }
}

/** Toggle menu + rebuild on each open. */
if (vglCopyPartBtn) {
    vglCopyPartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = vglCopyPartMenu.classList.toggle('open');
        if (isOpen) buildCopyPartMenu();
    });
}

/** Close menu when clicking anywhere outside. */
document.addEventListener('click', (e) => {
    if (vglCopyPartMenu && !vglCopyPartMenu.closest('.vgl-copy-part-wrap')?.contains(e.target)) {
        vglCopyPartMenu.classList.remove('open');
    }
});

// ============================================================
// LOADING STATE UI
// ============================================================

state.on('loadingChanged', () => {
    const loadingOverlay = getEl('loading-overlay');
    const loadingText = loadingOverlay?.querySelector('.loading-text');
    if (loadingOverlay) {
        loadingOverlay.classList.toggle('hidden', !state.isLoading);
        if (loadingText) loadingText.textContent = state.loadingText || 'Processing…';
    }
});
// ============================================================
// API LOGS PANEL
// ============================================================

if (logsToggle && logsContent && logsToggleIcon && logsClearBtn) {
    logsToggle.addEventListener('click', () => {
        const isOpen = !logsContent.classList.contains('hidden');
        logsContent.classList.toggle('hidden');
        logsToggleIcon.classList.toggle('open', !isOpen);
        logsClearBtn.classList.toggle('hidden', isOpen);
        if (!isOpen) renderLogs();
    });

    logsClearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.clearLogs();
    });
}

function renderLogs() {
    if (!logsList) return;
    logsList.innerHTML = '';
    state.logs.forEach(log => {
        const entry = document.createElement('div');
        entry.className = 'log-entry';

        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const typeClass = (log.type || 'info').toLowerCase();

        entry.innerHTML = `
            <div class="log-meta">
                <span class="log-time">[${timestamp}]</span>
                <span class="log-type ${typeClass}">${log.type || 'INFO'}</span>
                <span class="log-endpoint">${log.endpoint || ''}</span>
            </div>
            <div class="log-details">
                ${log.request ? `<pre class="log-json">REQ: ${JSON.stringify(log.request, null, 2)}</pre>` : ''}
                ${log.response ? `<pre class="log-json">RES: ${JSON.stringify(log.response, null, 2)}</pre>` : ''}
                ${log.error ? `<pre class="log-json">ERR: ${JSON.stringify(log.error, null, 2)}</pre>` : ''}
            </div>
        `;
        logsList.appendChild(entry);
    });

    if (state.logs.length === 0) {
        logsList.innerHTML = '<div class="log-entry" style="color: var(--text-muted); font-style: italic;">No logs yet...</div>';
    }
}

state.on('logsChanged', () => {
    if (logsContent && logsList && !logsContent.classList.contains('hidden')) {
        renderLogs();
        logsList.scrollTop = 0;
    }
});
