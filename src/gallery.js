import state from './state.js';
import {
    formatTime,
    copyToClipboard,
    downloadPNG,
    downloadJSON,
    downloadTxt,
    saveFilesToFolder,
    generateFilename,
    generateTxtFilename,
    generateTxtReport,
    showToast
} from './utils.js';
import { enhanceImage, increaseResolution } from './actions.js';

let reelScroll = null;
let imageCountBadge = null;
let contextMenu = null;
let ctxJumpParent = null;
let ctxJumpChild = null;
let contextImageId = null;

/**
 * Initialize the gallery reel.
 */
export function initGallery() {
    reelScroll = document.getElementById('reel-scroll');
    imageCountBadge = document.getElementById('image-count');
    contextMenu = document.getElementById('context-menu');
    ctxJumpParent = document.getElementById('ctx-jump-parent');
    ctxJumpChild = document.getElementById('ctx-jump-child');

    // Listen for state changes
    state.on('projectChanged', () => renderGallery());
    state.on('imagesAdded', () => renderGallery());
    state.on('imageStarred', () => renderGallery());
    state.on('imageDeleted', () => renderGallery());
    state.on('batchDeleted', () => renderGallery());
    state.on('featuredChanged', () => {
        highlightActive();
    });
    state.on('compareChanged', () => highlightActive());

    // Context menu actions
    contextMenu.addEventListener('click', handleContextAction);

    // Close context menu on click elsewhere
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            contextMenu.classList.add('hidden');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            contextMenu.classList.add('hidden');
        }
    });

    // Event Delegation for Gallery Actions
    reelScroll.addEventListener('click', (e) => {
        const thumb = e.target.closest('.thumbnail');
        if (thumb) {
            const imgId = thumb.dataset.imageId;

            // Check for Star toggle
            if (e.target.closest('.star-btn')) {
                state.toggleStar(imgId);
                return;
            }

            // Default selection
            state.setFeaturedImage(imgId);
            return;
        }

        const deleteBtn = e.target.closest('.batch-delete-btn');
        if (deleteBtn) {
            const batchId = deleteBtn.dataset.batchId;
            if (confirm('Delete this entire group of images?')) {
                state.deleteBatch(batchId).catch(err => showToast(err.message, 3000));
            }
            return;
        }
    });

    reelScroll.addEventListener('contextmenu', (e) => {
        const thumb = e.target.closest('.thumbnail');
        if (thumb) {
            e.preventDefault();
            showContextMenu(e, thumb.dataset.imageId);
        }
    });

    // Handle batch note changes
    reelScroll.addEventListener('input', (e) => {
        if (e.target.classList.contains('batch-note-input')) {
            const batchId = e.target.dataset.batchId;
            state.updateBatchNote(batchId, e.target.value);
        }
    });

    renderGallery();
}

/**
 * Render the full gallery from state.
 */
function renderGallery() {
    const batches = state.getImageBatches();

    // Update count
    const project = state.getActiveProject();
    const totalImages = project ? project.images.length : 0;
    imageCountBadge.textContent = totalImages;

    if (!batches.length) {
        reelScroll.innerHTML = `
      <div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;">
        No images yet.<br>Generate your first image below.
      </div>
    `;
        return;
    }

    reelScroll.innerHTML = batches.map(batch => renderBatch(batch)).join('');

    highlightActive();
}

/**
 * Render a single batch group.
 */
function renderBatch(batch) {
    const promptSnippet = batch.prompt
        ? (batch.prompt.length > 30 ? batch.prompt.substring(0, 30) + '…' : batch.prompt)
        : '(no prompt)';

    const modeIcon = batch.mode === 'generate' ? '✦' : batch.mode === 'refine' ? '⟲' : batch.mode === 'upload' ? '📎' : '✎';

    const thumbnails = batch.images.map(img => {
        // Lineage badges
        const hasParent = !!img.parentImageId;
        const hasDerivatives = img.derivativeCount > 0;

        return `
    <div class="thumbnail ${img.isReference ? 'reference-thumb' : ''} ${img.isStarred ? 'starred' : ''} ${hasParent ? 'has-parent' : ''} ${hasDerivatives ? 'has-derivatives' : ''}"
         data-image-id="${img.id}">
      <img src="${img.thumbnail || img.base64}" alt="Generated image" loading="lazy" />
      <span class="thumb-seed">${img.isReference ? 'UPLOAD' : img.seed}</span>
      <div class="thumb-actions">
        <button class="thumb-action-btn star-btn" title="${img.isStarred ? 'Unstar' : 'Star'} image">${img.isStarred ? '★' : '☆'}</button>
      </div>
      ${img.isReference ? '<div class="reference-badge">REF</div>' : ''}
    </div>
  `;
    }).join('');

    const noteValue = batch.note || batch.prompt || '';

    return `
    <div class="batch-group" data-batch-id="${batch.batchId}">
      <div class="batch-header">
        <div class="batch-top">
            <div class="batch-mode-badge ${batch.mode || 'generate'}">${(batch.mode || 'generate').toUpperCase()}</div>
            <div class="batch-meta">
                <span class="batch-time">${formatTime(batch.createdAt)}</span>
                <button class="batch-delete-btn" title="Delete Group" data-batch-id="${batch.batchId}">✕</button>
            </div>
        </div>
        <input type="text" class="batch-note-input" placeholder="Batch instructions/notes…" 
               value="${noteValue.replace(/"/g, '&quot;')}" 
               data-batch-id="${batch.batchId}" />
      </div>
      <div class="batch-grid">
        ${thumbnails}
      </div>
    </div>
  `;
}


/**
 * Show the custom context menu at the mouse position.
 */
function showContextMenu(e, imageId) {
    contextImageId = imageId;

    const img = state.getImage(imageId);

    // Show/hide Jump to Parent
    const hasParent = !!(img && img.parentImageId && state.getImage(img.parentImageId));
    ctxJumpParent?.classList.toggle('hidden', !hasParent);

    // Show/hide Jump to Child — find first direct derivative
    const project = state.getActiveProject();
    const firstChild = project?.images.find(i => i.parentImageId === imageId);
    ctxJumpChild?.classList.toggle('hidden', !firstChild);

    contextMenu.classList.remove('hidden');

    // Position
    const menuWidth = 200;
    const menuHeight = 280;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;

    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
}

/**
 * Handle context menu action clicks.
 */
async function handleContextAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const img = state.getImage(contextImageId);
    if (!img) return;

    contextMenu.classList.add('hidden');

    /**
     * Return the full base64 for an image — loads from disk in FS mode.
     */
    async function resolveBase64(imgRecord) {
        if (imgRecord.base64) return imgRecord.base64;
        if (state.storageType === 'fs') {
            const project = state.getActiveProject();
            if (project) {
                const { fsStorage } = await import('./fs-storage.js');
                return await fsStorage.loadImage(project.id, imgRecord.id);
            }
        }
        return null;
    }

    switch (action) {
        case 'compare':
            state.setCompareImage(contextImageId);
            break;

        case 'jump-to-parent': {
            if (img.parentImageId) {
                state.setFeaturedImage(img.parentImageId);
                scrollThumbnailIntoView(img.parentImageId);
            }
            break;
        }

        case 'jump-to-child': {
            const project = state.getActiveProject();
            const child = project?.images.find(i => i.parentImageId === contextImageId);
            if (child) {
                state.setFeaturedImage(child.id);
                scrollThumbnailIntoView(child.id);
            }
            break;
        }

        case 'star':
            state.toggleStar(contextImageId);
            break;

        case 'delete':
            if (confirm('Delete this image?')) {
                try {
                    await state.deleteImage(contextImageId);
                } catch (err) {
                    showToast(err.message, 3000);
                }
            }
            break;

        case 'show-in-folder':
            if (import.meta.env.DEV) {
                fetch('/api/storage/open-in-finder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: state.activeProjectId })
                });
            } else {
                showToast('Show Folder is only available in the local dev environment. Use Export to save files.');
            }
            break;

        case 'enhance':
            enhanceImage(contextImageId, {
                modContent: document.getElementById('mod-content-toggle').checked,
                modOutput: document.getElementById('mod-output-toggle').checked,
                ipSignal: document.getElementById('ip-signal-toggle').checked
            });
            break;

        case 'increase-resolution': {
            const scale = parseInt(btn.dataset.scale, 10) || 2;
            increaseResolution(contextImageId, scale);
            break;
        }

        case 'download-png': {
            const project = state.getActiveProject();
            const base = generateFilename(img, project?.name, project);
            const txtBase = generateTxtFilename(img, project?.name, project);
            const txtContent = project ? generateTxtReport(img, project) : '';
            const b64 = await resolveBase64(img);
            if (!b64) { showToast('Could not load image data.', 3000); break; }
            const files = [
                { name: base + '.png', blob: await fetch(b64).then(r => r.blob()) },
                ...(txtContent ? [{ name: txtBase + '.txt', blob: new Blob([txtContent], { type: 'text/plain;charset=utf-8' }) }] : [])
            ];
            const saved = await saveFilesToFolder(files);
            if (!saved) {
                downloadPNG(b64, base);
                if (txtContent) downloadTxt(txtContent, txtBase);
            }
            break;
        }

        case 'download-sp':
            if (img.structured_prompt) {
                const project = state.getActiveProject();
                const base = generateFilename(img, project?.name, project);
                const txtBase = generateTxtFilename(img, project?.name, project);
                const b64 = await resolveBase64(img);
                let spObj;
                try {
                    spObj = typeof img.structured_prompt === 'string'
                        ? JSON.parse(img.structured_prompt) : img.structured_prompt;
                } catch { spObj = img.structured_prompt; }
                const jsonStr = JSON.stringify(spObj, null, 2);
                const txtContent = project ? generateTxtReport(img, project) : '';
                const files = [
                    { name: base + '.json', blob: new Blob([jsonStr], { type: 'application/json' }) },
                    ...(b64 ? [{ name: base + '.png', blob: await fetch(b64).then(r => r.blob()) }] : []),
                    ...(txtContent ? [{ name: txtBase + '.txt', blob: new Blob([txtContent], { type: 'text/plain;charset=utf-8' }) }] : [])
                ];
                const saved = await saveFilesToFolder(files);
                if (!saved) {
                    downloadJSON(spObj, base);
                    if (b64) downloadPNG(b64, base);
                    if (txtContent) downloadTxt(txtContent, txtBase);
                }
            }
            break;

        case 'copy-seed':
            copyToClipboard(String(img.seed), 'Seed copied!');
            break;

        case 'copy-prompt':
            copyToClipboard(img.prompt || '', 'Prompt copied!');
            break;
    }
}

/**
 * Scroll a thumbnail element into view in the reel.
 */
function scrollThumbnailIntoView(imageId) {
    const el = reelScroll?.querySelector(`[data-image-id="${imageId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Build the full set of lineage image IDs relative to the featured image.
 * Returns { ancestors: Set<string>, descendants: Set<string> }
 */
function getLineageIds(featuredId) {
    const project = state.getActiveProject();
    if (!project || !featuredId) return { ancestors: new Set(), descendants: new Set() };

    const images = project.images;
    const ancestors = new Set();
    const descendants = new Set();

    // Walk UP: follow parentImageId chain
    let current = state.getImage(featuredId);
    while (current?.parentImageId) {
        ancestors.add(current.parentImageId);
        current = state.getImage(current.parentImageId);
    }

    // Walk DOWN: BFS through all images that derive from featuredId (or any descendant)
    const queue = [featuredId];
    while (queue.length) {
        const sourceId = queue.shift();
        for (const img of images) {
            if (img.parentImageId === sourceId && img.id !== featuredId) {
                descendants.add(img.id);
                queue.push(img.id);
            }
        }
    }

    return { ancestors, descendants };
}

/**
 * Highlight the active and compare-pinned thumbnails, plus lineage chain.
 */
function highlightActive() {
    if (!reelScroll) return;

    const { ancestors, descendants } = getLineageIds(state.featuredImageId);

    reelScroll.querySelectorAll('.thumbnail').forEach(el => {
        const imgId = el.dataset.imageId;
        el.classList.toggle('active', imgId === state.featuredImageId);
        el.classList.toggle('compare-pinned', imgId === state.compareImageId);
        el.classList.toggle('lineage-ancestor', ancestors.has(imgId));
        el.classList.toggle('lineage-descendant', descendants.has(imgId));
    });
}
