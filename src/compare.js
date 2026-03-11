import state from './state.js';
import { getZoomState } from './canvas.js';

let overlay = null;
let clipper = null;
let compareImg = null;
let wipeHandle = null;
let exitBtn = null;
let mainImage = null;
let viewerWrapper = null;
let isDragging = false;
let syncRafId = null;

/**
 * Initialize compare mode.
 */
export function initCompare() {
    overlay = document.getElementById('compare-overlay');
    clipper = document.getElementById('compare-clipper');
    compareImg = document.getElementById('compare-image');
    wipeHandle = document.getElementById('wipe-handle');
    exitBtn = document.getElementById('exit-compare-btn');
    mainImage = document.getElementById('main-image');
    viewerWrapper = document.getElementById('viewer-wrapper');

    state.on('compareChanged', () => updateCompare());
    state.on('zoomChanged', () => {
        if (state.compareActive) syncCompareImageSize();
    });

    exitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.exitCompare();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.compareActive) {
            state.exitCompare();
        }
    });

    wipeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || !state.compareActive) return;
        const rect = viewerWrapper.getBoundingClientRect();
        let x = (e.clientX - rect.left) / rect.width;
        x = Math.max(0, Math.min(1, x));
        state.wipePosition = x;
        applyWipePosition(x);
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });

    viewerWrapper.addEventListener('click', (e) => {
        if (!state.compareActive || isDragging) return;
        if (e.target.closest('.exit-compare-btn, .wipe-handle')) return;
        const rect = viewerWrapper.getBoundingClientRect();
        let x = (e.clientX - rect.left) / rect.width;
        x = Math.max(0, Math.min(1, x));
        state.wipePosition = x;
        applyWipePosition(x);
    });
}

function updateCompare() {
    if (state.compareActive && state.compareImageId) {
        const compareImgData = state.getImage(state.compareImageId);
        if (!compareImgData) {
            state.exitCompare();
            return;
        }
        compareImg.src = compareImgData.base64;
        overlay.classList.remove('hidden');
        overlay.classList.add('active');
        exitBtn.classList.remove('hidden');
        syncCompareImageSize();
        applyWipePosition(state.wipePosition);
    } else {
        overlay.classList.add('hidden');
        overlay.classList.remove('active');
        exitBtn.classList.add('hidden');
    }
}

function syncCompareImageSize() {
    if (!state.compareActive) return;
    if (syncRafId) cancelAnimationFrame(syncRafId);
    syncRafId = requestAnimationFrame(() => {
        const zoom = getZoomState();
        compareImg.style.transform = `translate(${zoom.translateX}px, ${zoom.translateY}px) scale(${zoom.scale})`;
        compareImg.style.transformOrigin = 'center';
    });
}

function applyWipePosition(x) {
    const pct = (x * 100).toFixed(2);
    clipper.style.clipPath = `inset(0 0 0 ${pct}%)`;
    wipeHandle.style.left = `${pct}%`;
}
