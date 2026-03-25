/* ============================================================
   canvas.js — Main image viewer & canvas management
   ============================================================ */

import state from './state.js';
import { enhanceImage, increaseResolution, removeBackground, eraseObject } from './actions.js';
import { copyToClipboard } from './utils.js';

const elements = {
    canvasArea: null,
    welcomeScreen: null,
    imageViewer: null,
    mainImage: null,
    imageInfoBar: null,
    infoSeed: null,
    infoPrompt: null,
    zoomIndicator: null,
    zoomFitBtn: null,
    zoom100Btn: null,
    loadingOverlay: null,
    loadingText: null,
    errorOverlay: null,
    errorMessage: null,
    viewerWrapper: null
};

// Zoom & Pan State
const zoomState = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    isPanning: false,
    startX: 0,
    startY: 0
};

// 'fit' | '100' | 'custom'
let zoomMode = 'fit';

/**
 * Initialize the canvas/viewer module.
 */
export function initCanvas() {
    elements.canvasArea = document.getElementById('canvas-area');
    elements.welcomeScreen = document.getElementById('welcome-screen');
    elements.imageViewer = document.getElementById('image-viewer');
    elements.mainImage = document.getElementById('main-image');
    elements.imageInfoBar = document.getElementById('image-info-bar');
    elements.infoSeed = document.getElementById('info-seed');
    elements.infoPrompt = document.getElementById('info-prompt');
    elements.zoomIndicator = document.getElementById('zoom-indicator');
    elements.zoomFitBtn    = document.getElementById('zoom-fit-btn');
    elements.zoom100Btn    = document.getElementById('zoom-100-btn');
    elements.loadingOverlay = document.getElementById('loading-overlay');
    elements.loadingText = elements.loadingOverlay?.querySelector('.loading-text');
    elements.errorOverlay = document.getElementById('error-overlay');
    elements.errorMessage = document.getElementById('error-message');
    elements.viewerWrapper = document.getElementById('viewer-wrapper');

    // Zoom control buttons
    elements.zoomFitBtn?.addEventListener('click', () => {
        zoomToFit();
    });
    elements.zoom100Btn?.addEventListener('click', () => {
        zoomTo100();
    });

    // Keyboard shortcuts  (ignore when typing in inputs)
    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea, select, [contenteditable]')) return;
        if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            zoomToFit();
        } else if (e.key === '1') {
            e.preventDefault();
            zoomTo100();
        }
    });

    // Listen for state changes
    state.on('projectChanged', () => updateView());
    state.on('imagesAdded', () => updateView()); // Ensure welcome screen hides when images appear
    state.on('featuredChanged', () => {
        resetZoom();
        updateFeaturedImage();
    });
    state.on('canvasLoadingChanged', () => updateLoadingState());
    state.on('loadingChanged', () => updateLoadingState());
    state.on('errorChanged', () => updateErrorState());

    // Zoom event
    elements.viewerWrapper.addEventListener('wheel', handleWheel, { passive: false });

    // Pan events
    elements.viewerWrapper.addEventListener('mousedown', startPan);
    window.addEventListener('mousemove', doPan);
    window.addEventListener('mouseup', endPan);

    // Canvas Right-Click Context Menu
    initCanvasContextMenu();

    updateView();
}

// ============================================================
// CANVAS CONTEXT MENU
// ============================================================

let canvasCtxMenu        = null;
let canvasCtxEraseSubmenu = null;
let canvasCtxEraseItem   = null;
let canvasCtxCopySubmenu = null;
let canvasCtxCopyItem    = null;
let canvasCtxCopyBg      = null;

function initCanvasContextMenu() {
    canvasCtxMenu        = document.getElementById('canvas-context-menu');
    canvasCtxEraseSubmenu = document.getElementById('canvas-ctx-erase-submenu');
    canvasCtxEraseItem   = document.getElementById('canvas-ctx-erase-item');
    canvasCtxCopySubmenu  = document.getElementById('canvas-ctx-copy-submenu');
    canvasCtxCopyItem     = document.getElementById('canvas-ctx-copy-item');
    canvasCtxCopyBg       = document.getElementById('canvas-ctx-copy-bg');
    if (!canvasCtxMenu) return;

    // Right-click on the viewer
    elements.viewerWrapper.addEventListener('contextmenu', (e) => {
        // Only show if an image is loaded
        if (!state.featuredImageId) return;
        e.preventDefault();
        showCanvasContextMenu(e);
    });

    // Dispatch actions
    canvasCtxMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-canvas-action]');
        if (!btn) return;

        const action = btn.dataset.canvasAction;
        const imageId = state.featuredImageId;
        if (!imageId) return;

        hideCanvasContextMenu();

        const modOpts = {
            modContent: document.getElementById('mod-content-toggle')?.checked,
            modOutput:  document.getElementById('mod-output-toggle')?.checked,
            ipSignal:   document.getElementById('ip-signal-toggle')?.checked
        };

        switch (action) {
            case 'enhance':
                enhanceImage(imageId, modOpts);
                break;
            case 'increase-resolution': {
                const scale = parseInt(btn.dataset.scale, 10) || 2;
                increaseResolution(imageId, scale);
                break;
            }
            case 'remove-background':
                removeBackground(imageId);
                break;
            case 'erase': {
                const desc = btn.dataset.desc;
                if (desc) eraseObject(imageId, desc);
                break;
            }
            case 'copy-object': {
                const json = btn.dataset.json;
                if (json) copyToClipboard(json, 'Object copied!');
                break;
            }
            case 'copy-background': {
                const bg = sp?.background_setting;
                if (bg) copyToClipboard(bg, 'Background copied!');
                break;
            }
        }
    });

    // Close on outside click or Escape
    document.addEventListener('click', (e) => {
        if (canvasCtxMenu && !canvasCtxMenu.contains(e.target)) {
            hideCanvasContextMenu();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideCanvasContextMenu();
    });
}

/**
 * Extract a short label (≤ 40 chars) from a VGL object entry.
 */
function objectShortLabel(obj) {
    const desc = obj.description || '';
    // Use the first sentence or first 40 chars, whichever is shorter
    const firstSentence = desc.split(/[.!?]/)[0].trim();
    const label = firstSentence || desc;
    return label.length > 45 ? label.slice(0, 42) + '…' : label;
}

function showCanvasContextMenu(e) {
    if (!canvasCtxMenu) return;

    // Build the Erase Object submenu from VGL objects
    const img = state.getFeaturedImage();
    let sp = null;
    if (img?.structured_prompt) {
        try {
            sp = typeof img.structured_prompt === 'string'
                ? JSON.parse(img.structured_prompt) : img.structured_prompt;
        } catch { sp = null; }
    }

    const objects = sp?.objects ?? [];

    // Erase submenu
    if (canvasCtxEraseSubmenu) {
        canvasCtxEraseSubmenu.innerHTML = '';
        if (objects.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'ctx-empty';
            empty.textContent = 'No VGL objects';
            canvasCtxEraseSubmenu.appendChild(empty);
        } else {
            objects.forEach((obj) => {
                const label = objectShortLabel(obj);
                const btn = document.createElement('button');
                btn.dataset.canvasAction = 'erase';
                btn.dataset.desc = label;
                btn.textContent = label;
                canvasCtxEraseSubmenu.appendChild(btn);
            });
        }
    }
    if (canvasCtxEraseItem) {
        canvasCtxEraseItem.style.display = objects.length === 0 && !sp ? 'none' : '';
    }

    // Copy Object submenu
    if (canvasCtxCopySubmenu) {
        canvasCtxCopySubmenu.innerHTML = '';
        if (objects.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'ctx-empty';
            empty.textContent = 'No VGL objects';
            canvasCtxCopySubmenu.appendChild(empty);
        } else {
            objects.forEach((obj) => {
                const label = objectShortLabel(obj);
                const btn = document.createElement('button');
                btn.dataset.canvasAction = 'copy-object';
                btn.dataset.json = JSON.stringify(obj, null, 2);
                btn.textContent = label;
                canvasCtxCopySubmenu.appendChild(btn);
            });
        }
    }
    if (canvasCtxCopyItem) {
        canvasCtxCopyItem.style.display = !sp ? 'none' : '';
    }

    // Copy Background button
    if (canvasCtxCopyBg) {
        canvasCtxCopyBg.style.display = sp?.background_setting ? '' : 'none';
    }

    // Position safely within viewport
    canvasCtxMenu.classList.remove('hidden');
    const menuW = canvasCtxMenu.offsetWidth  || 220;
    const menuH = canvasCtxMenu.offsetHeight || 180;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuW > window.innerWidth)  x = window.innerWidth  - menuW - 8;
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
    canvasCtxMenu.style.left = x + 'px';
    canvasCtxMenu.style.top  = y + 'px';
}

function hideCanvasContextMenu() {
    canvasCtxMenu?.classList.add('hidden');
}


/**
 * Reset zoom to Fit mode (default).
 */
function resetZoom() {
    zoomToFit();
}

/**
 * Zoom to Fit — scale=1 + centered (CSS handles contain scaling).
 */
export function zoomToFit() {
    zoomState.scale = 1;
    zoomState.translateX = 0;
    zoomState.translateY = 0;
    zoomMode = 'fit';
    applyZoom();
    state.emit('zoomChanged', getZoomState());
}

/**
 * Zoom to 100% — render image at its natural pixel dimensions.
 *
 * The <img> uses object-fit:contain, so the browser already applies a
 * "contain scale" of  min(wrapW/naturalW, wrapH/naturalH)  at transform
 * scale=1.  To make 1 image-pixel == 1 display-pixel we must invert that.
 */
export function zoomTo100() {
    if (!elements.mainImage || !elements.viewerWrapper) return;
    const img = elements.mainImage;
    const wrapper = elements.viewerWrapper;
    const naturalW = img.naturalWidth  || 512;
    const naturalH = img.naturalHeight || 512;
    const wrapW = wrapper.clientWidth;
    const wrapH = wrapper.clientHeight;
    const containScale = Math.min(wrapW / naturalW, wrapH / naturalH);
    // Multiply by 1/containScale so the net display scale is 1.0 (100%)
    zoomState.scale = containScale > 0 ? 1 / containScale : 1;
    zoomState.translateX = 0;
    zoomState.translateY = 0;
    zoomMode = '100';
    applyZoom();
    state.emit('zoomChanged', getZoomState());
}

/**
 * Handle mouse wheel for zooming.
 */
function handleWheel(e) {
    if (state.canvasLoading || !state.featuredImageId) return;
    e.preventDefault();

    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.1, Math.min(10, zoomState.scale * factor));

    if (newScale !== zoomState.scale) {
        zoomState.scale = newScale;
        zoomMode = 'custom';
        applyZoom();
        state.emit('zoomChanged', getZoomState());
    }
}

/**
 * Start panning.
 */
function startPan(e) {
    if (zoomState.scale <= 1 || e.button !== 0) return;
    zoomState.isPanning = true;
    zoomState.startX = e.clientX - zoomState.translateX;
    zoomState.startY = e.clientY - zoomState.translateY;
    elements.viewerWrapper.style.cursor = 'grabbing';
}

/**
 * Do panning.
 */
function doPan(e) {
    if (!zoomState.isPanning) return;
    zoomState.translateX = e.clientX - zoomState.startX;
    zoomState.translateY = e.clientY - zoomState.startY;
    applyZoom();
    state.emit('zoomChanged', getZoomState());
}

/**
 * End panning.
 */
function endPan() {
    if (!zoomState.isPanning) return;
    zoomState.isPanning = false;
    elements.viewerWrapper.style.cursor = '';
}

/**
 * Apply zoom and pan transforms to the main image.
 */
function applyZoom() {
    if (!elements.mainImage) return;
    elements.mainImage.style.transform = `translate(${zoomState.translateX}px, ${zoomState.translateY}px) scale(${zoomState.scale})`;

    // Update indicator text
    if (elements.zoomIndicator) {
        if (zoomMode === 'fit') {
            elements.zoomIndicator.textContent = 'Fit';
        } else if (zoomMode === '100') {
            elements.zoomIndicator.textContent = '100%';
        } else {
            elements.zoomIndicator.textContent = `${Math.round(zoomState.scale * 100)}%`;
        }
    }

    // Update active button state
    elements.zoomFitBtn?.classList.toggle('zoom-btn-active', zoomMode === 'fit');
    elements.zoom100Btn?.classList.toggle('zoom-btn-active', zoomMode === '100');
}

/**
 * Get current zoom state for external sync.
 */
export function getZoomState() {
    return { ...zoomState };
}

/**
 * Update the view based on current project state.
 */
function updateView() {
    const project = state.getActiveProject();

    if (!project) {
        // No project — show welcome
        elements.welcomeScreen.classList.remove('hidden');
        elements.imageViewer.classList.add('hidden');
        return;
    }

    if (project.images.length === 0) {
        // Empty project — show welcome with project context
        elements.welcomeScreen.classList.remove('hidden');
        elements.imageViewer.classList.add('hidden');
        return;
    }

    // Has images — show viewer
    elements.welcomeScreen.classList.add('hidden');
    elements.imageViewer.classList.remove('hidden');

    // If no featured image, auto-select the first
    if (!state.featuredImageId) {
        state.featuredImageId = project.images[0].id;
    }

    updateFeaturedImage();
}

/**
 * Update the main image display.
 */
function updateFeaturedImage() {
    const img = state.getFeaturedImage();
    if (!img) {
        elements.imageViewer.classList.add('hidden');
        elements.welcomeScreen.classList.remove('hidden');
        return;
    }

    elements.mainImage.src = img.base64;
    elements.infoSeed.textContent = `Seed: ${img.seed}`;
    const displayPrompt = img.prompt ? (img.prompt.length > 200 ? img.prompt.substring(0, 200) + '...' : img.prompt) : '(no prompt)';
    elements.infoPrompt.textContent = displayPrompt;

    // Show viewer if hidden
    elements.welcomeScreen.classList.add('hidden');
    elements.imageViewer.classList.remove('hidden');
}

/**
 * Update loading overlay.
 */
function updateLoadingState() {
    const show = !!state.canvasLoading;
    if (elements.loadingOverlay) elements.loadingOverlay.classList.toggle('hidden', !show);
    if (show && elements.loadingText) {
        elements.loadingText.textContent = state.loadingText || 'Generating…';
    }
}

/**
 * Update error overlay.
 */
function updateErrorState() {
    if (state.errorMessage) {
        elements.errorOverlay.classList.remove('hidden');
        elements.errorMessage.textContent = state.errorMessage;
    } else {
        elements.errorOverlay.classList.add('hidden');
    }
}
