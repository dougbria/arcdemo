import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STUDIO_PATH = path.join(os.homedir(), 'vgl_studio');

/**
 * Ensures the studio path and project directories exist.
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Main middleware for handling filesystem persistence.
 */
export function storageMiddleware(req, res, next) {
    if (!req.url.startsWith('/api/storage')) {
        return next();
    }

    const { method } = req;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.pathname.replace('/api/storage/', '');

    // Common JSON helper
    const sendJson = (data, status = 200) => {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = status;
        res.end(JSON.stringify(data));
    };

    const error = (msg, status = 500) => sendJson({ error: msg }, status);

    // Read body buffer
    let body = [];
    req.on('data', chunk => { body.push(chunk); });
    req.on('end', async () => {
        const payload = body.length > 0 ? JSON.parse(Buffer.concat(body).toString()) : null;

        try {
            ensureDir(STUDIO_PATH);

            switch (action) {
                case 'list-projects':
                    const folders = fs.readdirSync(STUDIO_PATH).filter(f => {
                        return fs.statSync(path.join(STUDIO_PATH, f)).isDirectory();
                    });
                    const projects = folders.map(f => {
                        const projectJson = path.join(STUDIO_PATH, f, 'project.json');
                        if (fs.existsSync(projectJson)) {
                            return JSON.parse(fs.readFileSync(projectJson, 'utf8'));
                        }
                        return null;
                    }).filter(p => p !== null);
                    return sendJson(projects);

                case 'save-project':
                    if (!payload || !payload.id) return error('No project data');
                    // Sanitized folder name: name_id
                    const folderName = `${payload.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${payload.id}`;
                    const projectDir = path.join(STUDIO_PATH, folderName);
                    ensureDir(projectDir);

                    // We save the project metadata as project.json within its dedicated folder.
                    // Images are saved as separate PNG files via the 'save-image' action.
                    fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(payload, null, 2));
                    return sendJson({ success: true, folder: folderName });

                case 'save-image':
                    if (!payload || !payload.projectId || !payload.imageId || !payload.base64) {
                        return error('Missing image data');
                    }
                    const pDir = fs.readdirSync(STUDIO_PATH).find(f => f.endsWith(payload.projectId));
                    if (!pDir) return error('Project not found');

                    const imgPath = path.join(STUDIO_PATH, pDir, `${payload.imageId}.png`);
                    const imgData = payload.base64.replace(/^data:image\/\w+;base64,/, '');
                    fs.writeFileSync(imgPath, Buffer.from(imgData, 'base64'));
                    return sendJson({ success: true, path: imgPath });

                case 'delete-project':
                    // Payload.id
                    const delDir = fs.readdirSync(STUDIO_PATH).find(f => f.endsWith(payload.id));
                    if (delDir) {
                        fs.rmSync(path.join(STUDIO_PATH, delDir), { recursive: true, force: true });
                    }
                    return sendJson({ success: true });

                case 'open-in-finder':
                    // Payload.projectId or imagePath
                    const targetFolder = payload.projectId
                        ? path.join(STUDIO_PATH, fs.readdirSync(STUDIO_PATH).find(f => f.endsWith(payload.projectId)))
                        : STUDIO_PATH;
                    const { exec } = await import('node:child_process');
                    exec(`open "${targetFolder}"`);
                    return sendJson({ success: true });

                case 'copy-starred':
                    // Payload.projects (array of project objects)
                    const exportDir = path.join(os.homedir(), 'Downloads', 'vgl_studio_exports');
                    ensureDir(exportDir);

                    let count = 0;
                    payload.projects.forEach(p => {
                        const pDir = fs.readdirSync(STUDIO_PATH).find(f => f.endsWith(p.id));
                        if (!pDir) return;

                        p.images.forEach(img => {
                            if (img.isStarred) {
                                const src = path.join(STUDIO_PATH, pDir, `${img.id}.png`);
                                if (fs.existsSync(src)) {
                                    const dest = path.join(exportDir, `${p.name}_${img.seed || img.id}.png`);
                                    fs.copyFileSync(src, dest);
                                    count++;
                                }
                            }
                        });
                    });

                    // Also open the export dir
                    const { exec: execExport } = await import('node:child_process');
                    execExport(`open "${exportDir}"`);

                    return sendJson({ success: true, count, path: exportDir });

                case 'proxy-image':
                    if (!payload || !payload.url) return error('No URL provided');
                    try {
                        const imgRes = await fetch(payload.url);
                        if (!imgRes.ok) throw new Error(`CDN returned ${imgRes.status}`);
                        const contentType = imgRes.headers.get('content-type') || 'image/png';
                        const buffer = await imgRes.arrayBuffer();
                        const base64 = `data:${contentType};base64,${Buffer.from(buffer).toString('base64')}`;
                        return sendJson({ base64 });
                    } catch (e) {
                        return error(`Proxy failed: ${e.message}`);
                    }

                default:
                    return error('Action not found', 404);
            }
        } catch (e) {
            console.error('[Storage Bridge ERROR]:', e);
            return error(e.message);
        }
    });
}
