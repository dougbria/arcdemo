/* ============================================================
   state.js — State management & filesystem persistence
   Uses the File System Access API (via fs-storage.js) when
   available (Chrome/Edge).  Falls back to localStorage for
   browsers that don't support it (Firefox, Safari, etc.).
   ============================================================ */

import { generateUUID } from './utils.js';
import { fsStorage } from './fs-storage.js';

// localStorage keys (only used for small prefs + LS fallback)
const STORAGE_PROJECT_PREFIX = 'vgl-project-';
const STORAGE_ACTIVE_KEY = 'vgl-studio-active-project';
const STORAGE_APIKEY_KEY = 'vgl-studio-api-key';
const STORAGE_SKIP_FS_KEY = 'vgl-studio-skip-fs';

// ---- localStorage fallback helpers ----

async function _lsLoadAllProjects() {
    const projects = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORAGE_PROJECT_PREFIX)) {
            try {
                const p = JSON.parse(localStorage.getItem(key));
                if (p && p.id) projects[p.id] = p;
            } catch (e) {
                console.warn('[State] Failed to parse LS project:', key, e);
            }
        }
    }
    return projects;
}

async function _lsSaveProject(project) {
    if (!project) return;
    try {
        localStorage.setItem(STORAGE_PROJECT_PREFIX + project.id, JSON.stringify(project));
    } catch (e) {
        console.error('[State] localStorage quota exceeded.', e);
    }
}

async function _lsDeleteProject(projectId) {
    localStorage.removeItem(STORAGE_PROJECT_PREFIX + projectId);
}


/**
 * Application state singleton.
 */
const state = {
    /** @type {Object<string, Project>} */
    projects: {},
    /** @type {string|null} */
    activeProjectId: null,
    /** @type {string|null} */
    featuredImageId: null,
    /** @type {string|null} */
    compareImageId: null,
    /** @type {boolean} */
    compareActive: false,
    /** @type {number} */
    wipePosition: 0.5,
    /** @type {boolean} */
    isLoading: false,
    /** @type {string|null} */
    errorMessage: null,
    /** @type {string} */
    lastPrompt: '',
    /** @type {Array} */
    logs: [],

    /**
     * 'fs'      — File System Access API, folder ready
     * 'pending' — FSA supported, no folder chosen yet
     * 'ls'      — localStorage fallback
     */
    storageType: 'pending',

    /** Event listeners */
    _listeners: {},

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
    },

    emit(event, data) {
        (this._listeners[event] || []).forEach(fn => fn(data));
    },

    // ---- Helpers: which backend is active? ----

    _useFS() {
        return this.storageType === 'fs';
    },

    // ============================================================
    // INITIALIZATION
    // ============================================================

    /**
     * Boot the app.  Tries to restore the FS folder; if it can't, sets
     * storageType to 'pending' so the UI shows the setup banner.
     */
    async init() {
        // Did the user previously opt out of filesystem storage?
        const skipFS = sessionStorage.getItem(STORAGE_SKIP_FS_KEY) === '1';

        if (!fsStorage.isSupported() || skipFS) {
            // Browser doesn't support FSA, or user chose to skip — use localStorage
            this.storageType = 'ls';
            this.projects = await _lsLoadAllProjects();
        } else {
            // Try to reconnect to the previously chosen folder
            const restored = await fsStorage.restore();
            if (restored) {
                this.storageType = 'fs';
                await this._loadProjectsFromFS();
            } else {
                // Folder not yet chosen (or permission not granted automatically)
                this.storageType = 'pending';
                this.projects = {};
            }
        }

        // Restore active project (stored in localStorage regardless of backend)
        this.activeProjectId = localStorage.getItem(STORAGE_ACTIVE_KEY) || null;
        if (this.activeProjectId && !this.projects[this.activeProjectId]) {
            this.activeProjectId = null;
            localStorage.removeItem(STORAGE_ACTIVE_KEY);
        }

        this.emit('init');
    },

    /**
     * Load all projects + their full-resolution images from the filesystem.
     * Thumbnails come from project.json directly (fast); full base64 is loaded
     * from individual PNG files in parallel.
     */
    async _loadProjectsFromFS() {
        const projects = await fsStorage.listProjects();

        // Eagerly load all image base64 in parallel
        const loaders = [];
        for (const project of Object.values(projects)) {
            for (const img of project.images) {
                loaders.push(
                    fsStorage.loadImage(project.id, img.id).then(b64 => {
                        img.base64 = b64;
                    })
                );
            }
        }
        if (loaders.length) {
            console.log(`[State] Loading ${loaders.length} image(s) from disk…`);
            await Promise.all(loaders);
        }

        this.projects = projects;
    },

    /**
     * Called by the UI when the user clicks "Choose Folder".
     * Returns true if storage is now ready.
     */
    async setupStorage() {
        const ok = await fsStorage.pickFolder();
        if (ok) {
            this.storageType = 'fs';
            await this._loadProjectsFromFS();

            // Restore active project after loading
            this.activeProjectId = localStorage.getItem(STORAGE_ACTIVE_KEY) || null;
            if (this.activeProjectId && !this.projects[this.activeProjectId]) {
                this.activeProjectId = null;
                localStorage.removeItem(STORAGE_ACTIVE_KEY);
            }

            this.emit('storageReady');
            this.emit('projectChanged');
        }
        return ok;
    },

    /**
     * Let the user skip FS storage and use localStorage instead.
     */
    async skipToLocalStorage() {
        sessionStorage.setItem(STORAGE_SKIP_FS_KEY, '1');
        this.storageType = 'ls';
        this.projects = await _lsLoadAllProjects();

        this.activeProjectId = localStorage.getItem(STORAGE_ACTIVE_KEY) || null;
        if (this.activeProjectId && !this.projects[this.activeProjectId]) {
            this.activeProjectId = null;
        }

        this.emit('storageReady');
        this.emit('projectChanged');
    },

    /**
     * Re-enable filesystem storage (used after "Use browser storage" is reversed).
     */
    async enableFsStorage() {
        sessionStorage.removeItem(STORAGE_SKIP_FS_KEY);
        this.storageType = 'pending';
        this.emit('storageChanged');
    },

    // ============================================================
    // PROJECT OPERATIONS
    // ============================================================

    getProjectList() {
        return Object.values(this.projects)
            .map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, imageCount: p.images.length }))
            .sort((a, b) => b.createdAt - a.createdAt);
    },

    getActiveProject() {
        if (!this.activeProjectId) return null;
        return this.projects[this.activeProjectId] || null;
    },

    async createProject(name) {
        const project = {
            id: generateUUID(),
            name: name.trim(),
            createdAt: Date.now(),
            images: []
        };
        this.projects[project.id] = project;
        this.activeProjectId = project.id;
        this.featuredImageId = null;
        this.compareImageId = null;
        this.compareActive = false;
        localStorage.setItem(STORAGE_ACTIVE_KEY, project.id);
        await this.save();
        this.emit('projectChanged');
        return project;
    },

    switchProject(projectId) {
        if (!this.projects[projectId]) return;
        this.activeProjectId = projectId;
        this.featuredImageId = null;
        this.compareImageId = null;
        this.compareActive = false;
        localStorage.setItem(STORAGE_ACTIVE_KEY, projectId);
        this.emit('projectChanged');
    },

    async deleteProject(projectId) {
        delete this.projects[projectId];
        if (this.activeProjectId === projectId) {
            this.activeProjectId = null;
            this.featuredImageId = null;
            this.compareImageId = null;
            this.compareActive = false;
            localStorage.removeItem(STORAGE_ACTIVE_KEY);
        }

        if (this._useFS()) {
            await fsStorage.deleteProject(projectId);
        } else {
            await _lsDeleteProject(projectId);
        }

        this.emit('projectChanged');
    },

    // ============================================================
    // IMAGE OPERATIONS
    // ============================================================

    /**
     * Add a single image to the active project.
     * Persists the PNG file immediately if using filesystem storage.
     */
    async addImage(img, prompt, mode, batchId, parentImageId = null) {
        const project = this.getActiveProject();
        if (!project) return null;

        const imageRecord = {
            id: generateUUID(),
            batchId,
            base64: img.base64,
            thumbnail: img.thumbnail,
            seed: img.seed || 0,
            prompt,
            structured_prompt: img.structured_prompt || null,
            mode,
            parentImageId,
            isReference: !!img.isReference,
            isStarred: false,
            createdAt: Date.now()
        };

        if (parentImageId) {
            const parent = this.getImage(parentImageId);
            if (parent) parent.derivativeCount = (parent.derivativeCount || 0) + 1;
        }

        project.images.unshift(imageRecord);
        this.featuredImageId = imageRecord.id;

        // Persist: PNG file first (only FS mode), then project.json / localStorage
        if (this._useFS()) {
            await fsStorage.saveImage(project, imageRecord.id, img.base64);
        }
        await this.save();

        this.emit('imagesAdded', { batchId, images: [imageRecord] });
        this.emit('featuredChanged');
        return imageRecord;
    },

    getImage(imageId) {
        for (const p of Object.values(this.projects)) {
            const img = p.images.find(i => i.id === imageId);
            if (img) return img;
        }
        return null;
    },

    getFeaturedImage() {
        if (!this.featuredImageId) return null;
        return this.getImage(this.featuredImageId);
    },

    setFeaturedImage(imageId) {
        this.featuredImageId = imageId;
        this.emit('featuredChanged');
    },

    getImageBatches() {
        const project = this.getActiveProject();
        if (!project || !project.images.length) return [];

        const batchMap = new Map();
        for (const img of project.images) {
            if (!batchMap.has(img.batchId)) {
                batchMap.set(img.batchId, {
                    batchId: img.batchId,
                    prompt: img.prompt,
                    mode: img.mode,
                    createdAt: img.createdAt,
                    images: []
                });
            }
            batchMap.get(img.batchId).images.push(img);
        }

        return Array.from(batchMap.values());
    },

    // ============================================================
    // GALLERY MANAGEMENT
    // ============================================================

    toggleStar(imageId) {
        const img = this.getImage(imageId);
        if (img) {
            img.isStarred = !img.isStarred;
            this.save();
            this.emit('imageStarred', { imageId, isStarred: img.isStarred });
        }
    },

    async deleteImage(imageId) {
        const img = this.getImage(imageId);
        if (!img) return;

        if (img.derivativeCount > 0) {
            throw new Error(`Cannot delete: this image has ${img.derivativeCount} refined/edited versions.`);
        }

        const project = this.getActiveProject();
        if (!project) return;

        if (img.parentImageId) {
            const parent = this.getImage(img.parentImageId);
            if (parent) parent.derivativeCount = Math.max(0, (parent.derivativeCount || 0) - 1);
        }

        project.images = project.images.filter(i => i.id !== imageId);

        if (this.featuredImageId === imageId) {
            this.featuredImageId = project.images[0]?.id || null;
            this.emit('featuredChanged');
        }

        await this.save();
        this.emit('imageDeleted', { imageId });
    },

    async deleteBatch(batchId) {
        const project = this.getActiveProject();
        if (!project) return;

        const batchImages = project.images.filter(img => img.batchId === batchId);
        const hasDerivatives = batchImages.some(img => (img.derivativeCount || 0) > 0);

        if (hasDerivatives) {
            throw new Error('Cannot delete batch: some images in this group have refined/edited versions.');
        }

        batchImages.forEach(img => {
            if (img.parentImageId) {
                const parent = this.getImage(img.parentImageId);
                if (parent) parent.derivativeCount = Math.max(0, (parent.derivativeCount || 0) - 1);
            }
        });

        project.images = project.images.filter(img => img.batchId !== batchId);

        if (batchImages.some(img => img.id === this.featuredImageId)) {
            this.featuredImageId = project.images[0]?.id || null;
            this.emit('featuredChanged');
        }

        await this.save();
        this.emit('batchDeleted', { batchId });
    },

    // ============================================================
    // COMPARE
    // ============================================================

    setCompareImage(imageId) {
        this.compareImageId = imageId;
        this.compareActive = true;
        this.wipePosition = 0.5;
        this.emit('compareChanged');
    },

    exitCompare() {
        this.compareActive = false;
        this.compareImageId = null;
        this.emit('compareChanged');
    },

    // ============================================================
    // API KEY
    // ============================================================

    getApiKey() {
        return localStorage.getItem(STORAGE_APIKEY_KEY) || '';
    },

    setApiKey(key) {
        localStorage.setItem(STORAGE_APIKEY_KEY, key);
        this.emit('apiKeyChanged');
    },

    // ============================================================
    // LOADING / ERROR
    // ============================================================

    setLoading(loading, text) {
        const wasLoading = this.isLoading;
        this.isLoading = loading;
        this.loadingText = text || 'Generating…';
        // Only show the canvas overlay when starting a *new* loading session.
        // Mid-batch status-text updates (wasLoading already true) must not
        // override an explicit setCanvasLoading(false) call.
        if (loading && !wasLoading) this.canvasLoading = true;
        if (!loading) this.canvasLoading = false;
        this.emit('loadingChanged');
        this.emit('canvasLoadingChanged');
    },

    /**
     * Hide just the canvas overlay while isLoading (and the interrupt button) stay active.
     * Call this after the first image arrives so the user can interact with it immediately.
     */
    setCanvasLoading(loading) {
        this.canvasLoading = loading;
        this.emit('canvasLoadingChanged');
    },

    setError(message) {
        this.errorMessage = message;
        this.emit('errorChanged');
    },

    clearError() {
        this.errorMessage = null;
        this.emit('errorChanged');
    },

    // ============================================================
    // LOGGING
    // ============================================================

    _sanitizeLog(obj) {
        if (!obj) return obj;
        if (typeof obj === 'string') {
            const isBase64Image = obj.startsWith('data:image/') ||
                (obj.length > 300 && !obj.includes(' ') && !obj.trim().startsWith('{') && !obj.trim().startsWith('['));
            if (isBase64Image) return `[image (${Math.round(obj.length / 1024)} KB)]`;
            return obj;
        }
        if (obj instanceof Error) return { message: obj.message, name: obj.name, stack: obj.stack };
        if (Array.isArray(obj)) return obj.map(item => this._sanitizeLog(item));
        if (typeof obj === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(obj)) out[k] = this._sanitizeLog(v);
            return out;
        }
        return obj;
    },

    addLog(log) {
        console.log(`[TRACE] state.addLog called for ${log.type}`, { endpoint: log.endpoint });
        let sanitizedLog;
        try {
            sanitizedLog = this._sanitizeLog(log);
        } catch (e) {
            console.error('[TRACE] state.addLog - Sanitization failed', e);
            sanitizedLog = { type: 'error', message: 'Failed to sanitize log', error: e.message };
        }
        this.logs.unshift({ timestamp: Date.now(), ...sanitizedLog });
        if (this.logs.length > 50) this.logs.length = 50;
        this.emit('logsChanged');
    },

    clearLogs() {
        this.logs = [];
        this.emit('logsChanged');
    },

    // ============================================================
    // BATCH NOTES
    // ============================================================

    updateBatchNote(batchId, note) {
        const project = this.getActiveProject();
        if (!project) return;
        if (!project.batchNotes) project.batchNotes = {};
        project.batchNotes[batchId] = note;
        this.save();
    },

    getBatchNote(batchId) {
        return this.getActiveProject()?.batchNotes?.[batchId] || '';
    },

    // ============================================================
    // SAVE (dispatcher)
    // ============================================================

    async save() {
        const project = this.getActiveProject();
        if (!project) return;

        if (this._useFS()) {
            // Filesystem: project.json (no base64 — those live as separate .png files)
            await fsStorage.saveProject(project);
        } else {
            // localStorage fallback: store everything including base64
            await _lsSaveProject(project);
        }
    }
};

const globalState = window.__VGL_STATE__ || state;
window.__VGL_STATE__ = globalState;
export default globalState;
