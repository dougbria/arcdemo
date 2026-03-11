/* ============================================================
   utils.js — Helper utilities
   ============================================================ */

/**
 * Generate a simple UUID v4.
 */
export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/**
 * Generate a random seed (positive integer, up to 2^31).
 */
export function randomizeSeed() {
    return Math.floor(Math.random() * 2147483647);
}

/**
 * Create a thumbnail from a base64 image string.
 */
export function createThumbnail(base64, maxSize = 200) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/png'));
        };
        img.src = base64;
    });
}

// ============================================================
// FILENAME CONVENTION
// [project]_[note_or_prompt]_[seed]_[timestamp].ext  (images/json)
// [project]_[note_or_prompt]_[timestamp].txt          (text report)
// If a batch note exists it is used as the slug; otherwise the
// first 5 words of the prompt are used.
// ============================================================

/**
 * Convert a timestamp (ms) to YYYYMMDD_HHMMSS string.
 */
function formatTimestamp(ts) {
    const d = new Date(ts || Date.now());
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Sanitize any string for use in a filename.
 * Lowercases, replaces spaces and special characters with underscores,
 * collapses repeated underscores, and trims leading/trailing ones.
 */
function toSlug(text, maxWords = 5) {
    if (!text) return null;
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')   // strip special chars
        .trim()
        .split(/\s+/)                  // split on whitespace
        .filter(Boolean)
        .slice(0, maxWords)
        .join('_') || null;
}

/**
 * Extract ~5-word slug from a prompt string.
 */
function promptSlug(prompt) {
    return toSlug(prompt, 5) || 'untitled';
}

/**
 * Extract up to 7-word slug from a batch note.
 * Returns null if the note is empty/missing.
 */
function noteSlug(note) {
    return toSlug(note, 7);
}

/**
 * Sanitize a project name for use in filenames.
 */
function projectSlug(name) {
    if (!name) return 'vgl';
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

/**
 * Generate the base filename (no extension) for an image file.
 * Format: [project]_[note_or_prompt]_[seed]_[timestamp]
 *
 * If the image's batch has a note, it is used as the label instead of
 * the prompt, giving exported files more meaningful names when annotated.
 *
 * @param {Object} img          - Image record (prompt, seed, createdAt, batchId)
 * @param {string} projectName
 * @param {Object} [project]    - Full project object (for batchNotes lookup)
 * @returns {string}
 */
export function generateFilename(img, projectName, project) {
    // Legacy call signature: generateFilename(promptString, seed)
    if (typeof img === 'string') {
        const slug = promptSlug(img);
        const proj = projectSlug(projectName || 'vgl');
        const ts = formatTimestamp(Date.now());
        const seed = projectName || '';
        return `${proj}_${slug}_${seed ? seed + '_' : ''}${ts}`;
    }

    const proj = projectSlug(projectName || 'vgl');
    const ts = formatTimestamp(img.createdAt);
    const seed = img.seed || 0;

    // Prefer batch note → fall back to prompt slug
    const batchNote = project?.batchNotes?.[img.batchId] || img.batchNote || '';
    const slug = noteSlug(batchNote) || promptSlug(img.prompt);

    return `${proj}_${slug}_${seed}_${ts}`;
}

/**
 * Generate the base filename for a .txt report (no seed).
 * Format: [project]_[note_or_prompt]_[timestamp]
 */
export function generateTxtFilename(img, projectName, project) {
    const proj = projectSlug(projectName || 'vgl');
    const ts = formatTimestamp(img.createdAt);

    const batchNote = project?.batchNotes?.[img.batchId] || img.batchNote || '';
    const slug = noteSlug(batchNote) || promptSlug(img.prompt);

    return `${proj}_${slug}_${ts}`;
}

// ============================================================
// DOWNLOAD HELPERS
// ============================================================

/**
 * Trigger a browser download of a PNG from base64.
 */
export function downloadPNG(base64, filename = 'image') {
    const link = document.createElement('a');
    link.href = base64;
    link.download = filename.endsWith('.png') ? filename : filename + '.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Trigger a browser download of a JSON object.
 */
export function downloadJSON(obj, filename = 'vgl') {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.endsWith('.json') ? filename : filename + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Trigger a browser download of a plain text file.
 */
export function downloadTxt(content, filename = 'report') {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.endsWith('.txt') ? filename : filename + '.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Show the OS folder picker immediately within a user gesture.
 * Returns the chosen FileSystemDirectoryHandle, null if unsupported,
 * or throws an AbortError if the user cancelled.
 *
 * ⚠️  Must be called synchronously (or as the first await) inside a
 *    click / keydown handler — the browser blocks it once the gesture expires.
 */
export async function pickExportFolder() {
    if (!window.showDirectoryPicker) return null;
    return await window.showDirectoryPicker({ mode: 'readwrite' });
}

/**
 * Write an array of { name, blob } files into an already-opened directory handle.
 */
export async function writeFilesToHandle(dirHandle, files) {
    for (const { name, blob } of files) {
        try {
            const fh = await dirHandle.getFileHandle(name, { create: true });
            const writable = await fh.createWritable();
            await writable.write(blob);
            await writable.close();
        } catch (e) {
            console.error(`Failed to write ${name}:`, e);
        }
    }
}

/**
 * Convenience: pick a folder then write files.
 * Only use this when there is NO async work between the user gesture and this call.
 * For cases with prior async work (e.g. loading images) use pickExportFolder +
 * writeFilesToHandle separately.
 *
 * @returns {Promise<boolean>} true if saved, false if unsupported, re-throws AbortError
 */
export async function saveFilesToFolder(files) {
    if (!window.showDirectoryPicker) return false;
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await writeFilesToHandle(dirHandle, files);
    return true;
}

// ============================================================
// TXT REPORT GENERATOR
// ============================================================

/**
 * Build and return the .txt report content for a given image.
 *
 * Includes:
 *  - Original user prompt
 *  - Batch notes
 *  - ASCII lineage tree showing ancestors → this image ★ → descendants
 *
 * @param {Object} img        - The image record
 * @param {Object} project    - The full project object (has .images, .name)
 * @returns {string}
 */
export function generateTxtReport(img, project) {
    const projectName = project.name || 'vgl';
    const lines = [];
    const hr = '─'.repeat(60);

    lines.push('BRIA ARC — IMAGE EXPORT REPORT');
    lines.push(hr);
    lines.push(`Project:    ${projectName}`);
    lines.push(`Image ID:   ${img.id}`);
    lines.push(`Mode:       ${(img.mode || 'generate').toUpperCase()}`);
    lines.push(`Seed:       ${img.seed || 'N/A'}`);
    lines.push(`Created:    ${new Date(img.createdAt).toLocaleString()}`);
    lines.push('');

    // Prompt
    lines.push('ORIGINAL PROMPT');
    lines.push(hr);
    lines.push(img.prompt || '(no prompt)');
    lines.push('');

    // Batch notes
    const batchImages = project.images.filter(i => i.batchId === img.batchId);
    const batchNote = batchImages.length > 0 ? (batchImages[0].batchNote || '') : '';
    // try the batch note from the first image or from a batches index
    const batch = project.images.find(i => i.batchId === img.batchId);

    // Notes are stored on the project level batches map
    lines.push('BATCH NOTES');
    lines.push(hr);
    const note = img.batchNote || project.batchNotes?.[img.batchId] || '(none)';
    lines.push(note);
    lines.push('');

    // Build lineage tree
    lines.push('LINEAGE TREE');
    lines.push(hr);
    lines.push('(★ = this image, filenames show what would be downloaded)');
    lines.push('');

    const allImages = project.images;

    // Walk UP to find root ancestor
    const chain = []; // [rootmost → ... → this image]
    let cur = img;
    while (cur) {
        chain.unshift(cur);
        cur = cur.parentImageId ? allImages.find(i => i.id === cur.parentImageId) : null;
    }

    // Render the tree with BFS downward from each node in chain
    function renderNode(node, prefix, isLast, targetId) {
        const isSelf = node.id === targetId;
        const fname = generateFilename(node, projectName, project) + '.png';
        const mode = (node.mode || 'generate').toUpperCase();
        const marker = isSelf ? ' ★' : '';
        const connector = isLast ? '└── ' : '├── ';
        lines.push(`${prefix}${connector}${fname}  [${mode} / seed ${node.seed || 0}]${marker}`);

        const children = allImages.filter(i => i.parentImageId === node.id);
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        children.forEach((child, idx) => {
            renderNode(child, childPrefix, idx === children.length - 1, targetId);
        });
    }

    // Render from root
    const root = chain[0];
    const rootFname = generateFilename(root, projectName, project) + '.png';
    const rootMode = (root.mode || 'generate').toUpperCase();
    const rootMarker = root.id === img.id ? ' ★' : '';
    lines.push(`${rootFname}  [${rootMode} / seed ${root.seed || 0}]${rootMarker}`);

    if (root.id !== img.id) {
        const rootChildren = allImages.filter(i => i.parentImageId === root.id);
        rootChildren.forEach((child, idx) => {
            renderNode(child, '', idx === rootChildren.length - 1, img.id);
        });
    }

    lines.push('');
    lines.push(hr);
    lines.push('Generated by Bria Arc');

    return lines.join('\n');
}

// ============================================================
// MISC UTILITIES
// ============================================================

/**
 * Copy text to clipboard and show toast.
 */
export async function copyToClipboard(text, label = 'Copied!') {
    try {
        await navigator.clipboard.writeText(text);
        showToast(label);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(label);
    }
}

/**
 * Show a brief toast notification.
 */
export function showToast(message, duration = 5000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

/**
 * Convert a File to a base64 data URL.
 */
export function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Format a timestamp to a short readable string (for UI display, not filenames).
 */
export function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Recursively find keys that differ between two objects.
 * Returns an array of dot-notated paths.
 */
export function findDiffPaths(oldObj, newObj, path = '') {
    let diffs = [];

    if (oldObj && typeof oldObj === 'object' && !Array.isArray(oldObj) &&
        newObj && typeof newObj === 'object' && !Array.isArray(newObj)) {
        const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
        for (const key of allKeys) {
            const fullPath = path ? `${path}.${key}` : key;
            diffs = diffs.concat(findDiffPaths(oldObj[key], newObj[key], fullPath));
        }
        return diffs;
    }

    if (Array.isArray(oldObj) && Array.isArray(newObj)) {
        const len = Math.max(oldObj.length, newObj.length);
        for (let i = 0; i < len; i++) {
            const fullPath = path ? `${path}.${i}` : String(i);
            diffs = diffs.concat(findDiffPaths(oldObj[i], newObj[i], fullPath));
        }
        return diffs;
    }

    if (JSON.stringify(oldObj) !== JSON.stringify(newObj)) {
        if (path) diffs.push(path);
    }

    return diffs;
}
