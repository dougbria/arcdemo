/* ============================================================
   fs-storage.js — File System Access API storage layer
   Stores projects and images in a user-chosen local folder.
   Works in Chrome/Edge for both dev and GitHub Pages deployments.
   ============================================================ */

const IDB_NAME = 'vgl-studio-fs';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'root-dir';

// ---- IndexedDB helpers ----

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function idbDelete(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---- Permission helper ----

async function verifyPermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
}

// ---- Public API ----

export const fsStorage = {
    /** @type {FileSystemDirectoryHandle|null} */
    rootDir: null,

    /** True if the browser supports the File System Access API. */
    isSupported() {
        return 'showDirectoryPicker' in window;
    },

    /**
     * Try to restore a previously stored directory handle and re-grant permission.
     * Returns true if the folder is ready to use.
     */
    async restore() {
        try {
            const handle = await idbGet(HANDLE_KEY);
            if (!handle) return false;
            const ok = await verifyPermission(handle);
            if (ok) { this.rootDir = handle; return true; }
            return false;
        } catch (e) {
            console.warn('[FSStorage] restore failed:', e);
            return false;
        }
    },

    /**
     * Returns true if there is a stored handle (even if permission hasn't been
     * granted yet this session).  Used to decide whether to show "Reconnect"
     * vs. "Choose Folder".
     */
    async hasStoredHandle() {
        try {
            return !!(await idbGet(HANDLE_KEY));
        } catch { return false; }
    },

    /**
     * Show the OS folder picker and persist the chosen handle.
     * Returns true on success, false if the user cancelled.
     */
    async pickFolder() {
        try {
            const handle = await window.showDirectoryPicker({
                id: 'vgl-studio-root',
                mode: 'readwrite',
                startIn: 'documents'
            });
            await idbSet(HANDLE_KEY, handle);
            this.rootDir = handle;
            return true;
        } catch (e) {
            return false; // User cancelled
        }
    },

    /** Forget the stored folder (e.g. to switch to a different one). */
    async disconnect() {
        await idbDelete(HANDLE_KEY);
        this.rootDir = null;
    },

    /** Display name of the current root folder, or null. */
    getFolderName() {
        return this.rootDir?.name ?? null;
    },

    // ---- Internal helpers ----

    async _findProjectDir(projectId) {
        if (!this.rootDir) return null;
        for await (const [name, handle] of this.rootDir.entries()) {
            if (handle.kind === 'directory' && name.endsWith(`_${projectId}`)) {
                return handle;
            }
        }
        return null;
    },

    async _getOrCreateProjectDir(project) {
        const safe = project.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return this.rootDir.getDirectoryHandle(`${safe}_${project.id}`, { create: true });
    },

    // ---- Project I/O ----

    /**
     * Read all projects from the root directory.
     * Images will have `thumbnail` (from project.json) but `base64 = null`.
     * Call loadImage() separately to populate base64.
     */
    async listProjects() {
        if (!this.rootDir) return {};
        const projects = {};
        for await (const [, handle] of this.rootDir.entries()) {
            if (handle.kind !== 'directory') continue;
            try {
                const fh = await handle.getFileHandle('project.json');
                const text = await (await fh.getFile()).text();
                const proj = JSON.parse(text);
                if (proj?.id) projects[proj.id] = proj;
            } catch { /* not a project dir */ }
        }
        return projects;
    },

    /**
     * Load a single image's full base64 from its on-disk PNG.
     * Returns null if the file doesn't exist.
     */
    async loadImage(projectId, imageId) {
        const dir = await this._findProjectDir(projectId);
        if (!dir) return null;
        try {
            const fh = await dir.getFileHandle(`${imageId}.png`);
            const file = await fh.getFile();
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(file);
            });
        } catch { return null; }
    },

    /**
     * Write project metadata to project.json.
     * Strips `base64` (stored as PNG files) but keeps `thumbnail` for fast gallery loads.
     */
    async saveProject(project) {
        if (!this.rootDir) return;
        const dir = await this._getOrCreateProjectDir(project);
        // Strip full base64; keep thumbnail (small, ~15 KB) for fast gallery rendering
        const serializable = {
            ...project,
            images: project.images.map(({ base64, ...rest }) => rest)
        };
        const fh = await dir.getFileHandle('project.json', { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(serializable, null, 2));
        await w.close();
    },

    /**
     * Write a single image's full-resolution data as a PNG file.
     */
    async saveImage(project, imageId, base64) {
        if (!this.rootDir || !base64) return;
        const dir = await this._getOrCreateProjectDir(project);
        const raw = base64.replace(/^data:image\/\w+;base64,/, '');
        const binary = atob(raw);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const fh = await dir.getFileHandle(`${imageId}.png`, { create: true });
        const w = await fh.createWritable();
        await w.write(new Blob([bytes], { type: 'image/png' }));
        await w.close();
    },

    /**
     * Recursively remove a project's directory.
     */
    async deleteProject(projectId) {
        if (!this.rootDir) return;
        for await (const [name, handle] of this.rootDir.entries()) {
            if (handle.kind === 'directory' && name.endsWith(`_${projectId}`)) {
                await this.rootDir.removeEntry(name, { recursive: true });
                return;
            }
        }
    }
};
