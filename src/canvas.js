/* ============================================================
   canvas.js — Main image viewer & canvas management
   ============================================================ */

import state from './state.js';

const elements = {
    canvasArea: null,
    welcomeScreen: null,
    imageViewer: null,
    mainImage: null,
    imageInfoBar: null,
    infoSeed: null,
    infoPrompt: null,
    zoomIndicator: null,
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
    elements.loadingOverlay = document.getElementById('loading-overlay');
    elements.loadingText = elements.loadingOverlay?.querySelector('.loading-text');
    elements.errorOverlay = document.getElementById('error-overlay');
    elements.errorMessage = document.getElementById('error-message');
    elements.viewerWrapper = document.getElementById('viewer-wrapper');

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

    updateView();
}

/**
 * Reset zoom state to default.
 */
function resetZoom() {
    zoomState.scale = 1;
    zoomState.translateX = 0;
    zoomState.translateY = 0;
    applyZoom();
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
    if (elements.zoomIndicator) {
        elements.zoomIndicator.textContent = `${Math.round(zoomState.scale * 100)}%`;
    }
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
