/* ============================================================
   api.js — Bria AI API service
   Endpoints: /v2/image/generate, /v2/structured_prompt/generate,
              /v2/structured_prompt/generate_from_diff
   ============================================================ */

import state from './state.js';
import { randomizeSeed } from './utils.js';

/**
 * Base API configuration.
 * In dev, Vite proxies /api → Bria's engine.
 * In production (GitHub Pages / any static host), call Bria directly —
 * their API supports cross-origin requests from any browser origin.
 */
const BRIA_API_URL = 'https://engine.prod.bria-api.com/v2';
const API_BASE = import.meta.env.PROD ? BRIA_API_URL : '/api';
const TIMEOUT = 180_000; // 3 minutes for sync requests

// ============================================================
// Core HTTP helpers
// ============================================================

/**
 * INTERNAL: Base HTTP request logic.
 */
async function _internalBriaRequest(endpoint, body, method = 'POST', requestOptions = {}) {
    const apiKey = state.getApiKey();
    if (!apiKey) {
        throw new Error('Bria API Token is required. Enter it in the header bar.');
    }

    const url = API_BASE + endpoint;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    console.log(`[API] Starting ${method} request to ${url}`, body);

    try {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'api_token': apiKey
            },
            signal: controller.signal
        };

        if (method === 'POST') {
            const requestBody = { ...body };
            // Default to ASYNC (no sync=true) for reliability
            if (requestOptions.forceSync) {
                requestBody.sync = true;
            }
            options.body = JSON.stringify(requestBody);
        }

        const logItem = {
            type: 'request',
            endpoint,
            method,
            request: body
        };

        state.addLog({ ...logItem, type: 'request-init' });

        const response = await fetch(url, options);
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);

            // Bria uses both { message } and FastAPI's { detail: [...] } formats
            let msg = errorData?.message
                || errorData?.error?.message
                || (Array.isArray(errorData?.detail)
                    ? errorData.detail.map(d => `${d.loc?.join('.')} — ${d.msg}`).join('; ')
                    : errorData?.detail)
                || `API error: ${response.status} ${response.statusText}`;

            // Tag 429 specifically for the retry loop
            const finalMsg = response.status === 429 ? `429: ${msg}` : msg;

            state.addLog({
                ...logItem,
                type: 'error',
                error: errorData || { message: msg, status: response.status }
            });
            throw new Error(finalMsg);
        }

        const data = await response.json();
        console.log(`[TRACE] _internalBriaRequest raw response from ${endpoint}:`, {
            status: data.status,
            hasResult: !!data.result,
            hasRequestId: !!data.request_id,
            hasStatusUrl: !!data.status_url
        });

        // Check for error in body even if status 200 (e.g. moderation or internal error fields)
        if (data.error || data.message?.toLowerCase().includes('moderation') || data.message?.toLowerCase().includes('error')) {
            const msg = data.error?.message || data.message || 'API internal error';
            state.addLog({ ...logItem, type: 'error', error: data });
            throw new Error(msg);
        }

        state.addLog({ ...logItem, type: 'response', response: data });

        // Immediate result (sync)
        if (data.result && (!data.request_id || data.status === 'COMPLETED')) {
            console.log('[TRACE] _internalBriaRequest - returning immediate result');
            return data;
        }

        // Asynchronous Pattern (polling)
        if ((data.status_url || data.request_id) && data.status !== 'COMPLETED') {
            const requestId = data.request_id || data.status_url.split('/').pop();
            console.log(`[TRACE] _internalBriaRequest - starting poll for ${requestId}`);
            return await pollStatus(requestId);
        }

        return data;
    } catch (err) {
        clearTimeout(timeoutId);

        // Detailed error logging for catch block
        state.addLog({
            type: 'error',
            endpoint,
            error: {
                name: err.name,
                message: err.message,
                stack: err.stack,
                context: 'Request failed in catch block'
            }
        });

        if (err.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw err;
    }
}

/**
 * Make an authenticated request to Bria's API with retry logic for rate limits.
 */
async function briaRequest(endpoint, body, method = 'POST', requestOptions = {}) {
    console.log(`[TRACE] briaRequest called: ${endpoint}`, { method, bodyKeys: Object.keys(body) });
    const MAX_RETRIES = 5;
    let backoff = 5000; // Start with 5s backoff

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`[TRACE] briaRequest attempt ${attempt + 1}/${MAX_RETRIES + 1} for ${endpoint}`);
            return await _internalBriaRequest(endpoint, body, method, requestOptions);
        } catch (err) {
            console.error(`[TRACE] briaRequest failed at attempt ${attempt + 1}:`, err.message);
            const isRateLimit = err.message.includes('429') || err.message.toLowerCase().includes('too many requests');

            if (isRateLimit && attempt < MAX_RETRIES) {
                console.warn(`[API] Rate limit hit. Retrying in ${backoff}ms... (${attempt + 1}/${MAX_RETRIES})`);
                state.addLog({
                    type: 'retry',
                    endpoint,
                    message: `Rate limit hit (429), retrying in ${backoff}ms (${attempt + 1}/${MAX_RETRIES})`
                });
                await new Promise(r => setTimeout(r, backoff));
                backoff *= 2;
                continue;
            }
            throw err;
        }
    }
}

/**
 * Poll the status endpoint until completion.
 */
async function pollStatus(requestId) {
    const POLL_INTERVAL = 5000;
    const MAX_POLLS = 120; // 10 min at 5s intervals

    // Small initial delay for eventual consistency on Bria's side
    await new Promise(r => setTimeout(r, 2000));

    for (let i = 0; i < MAX_POLLS; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, POLL_INTERVAL));

        const apiKey = state.getApiKey();
        try {
            const response = await fetch(`${API_BASE}/status/${requestId}`, {
                headers: { 'api_token': apiKey }
            });

            if (!response.ok) {
                if (response.status === 429) continue; // Just wait longer for status checks
                throw new Error(`Status check failed: ${response.status}`);
            }

            const data = await response.json();
            const status = data.status || 'UNKNOWN';

            switch (status) {
                case 'COMPLETED':
                case 'SUCCESS':
                    state.addLog({
                        type: 'response',
                        endpoint: `/status/${requestId}`,
                        response: data
                    });
                    return data;
                case 'ERROR':
                case 'FAILED':
                    state.addLog({
                        type: 'error',
                        endpoint: `/status/${requestId}`,
                        error: data.error || data
                    });
                    throw new Error(data.error?.message || 'Generation failed.');
                case 'IN_PROGRESS':
                case 'QUEUED':
                case 'PENDING':
                    state.setLoading(true, `Processing… (${i + 1})`);
                    continue;
                default:
                    console.warn(`[API] Unexpected/UNKNOWN status: ${status}`, data);
                    // If it's UNKNOWN for more than 4 attempts, it's likely an invalid ID or a system glitch
                    if (status === 'UNKNOWN' && i > 4) {
                        const fatalErr = new Error(`Request entered an unknown state: ${status}. Please try again.`);
                        fatalErr.isPollingFatal = true;
                        throw fatalErr;
                    }
                    continue;
            }
        } catch (err) {
            console.error(`[API] Poll attempt ${i} failed:`, err.message);
            // If it's our fatal error or a real failure (not a 429), re-throw to stop the loop
            if (err.isPollingFatal || i === MAX_POLLS - 1 || (!err.message.includes('Status check failed') && !err.message.includes('429'))) {
                throw err;
            }
        }
    }

    throw new Error('Request timed out while polling for results.');
}

/**
 * Fetch an image from a URL and convert to base64 data URL.
 *
 * In dev: route through the Vite storage-bridge proxy so the Node.js server
 *   fetches the CDN URL server-side, avoiding CORS issues with localhost.
 * In prod: fetch the CDN URL directly from the browser — Bria's CDN returns
 *   permissive CORS headers that allow any origin.
 */
async function fetchImageAsBase64(imageUrl) {
    if (imageUrl.startsWith('data:')) return imageUrl;

    if (import.meta.env.DEV) {
        // Dev: use the server-side proxy to avoid CDN CORS restrictions on localhost
        const response = await fetch('/api/storage/proxy-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: imageUrl })
        });
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(`Proxy fetch failed: ${errData.error || response.status}`);
        }
        const data = await response.json();
        return data.base64;
    }

    // Prod: fetch directly — CDN allows cross-origin requests
    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch image from CDN: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ============================================================
// Public API methods
// ============================================================

const api = {

    /**
     * Generate a single image from a text prompt (and optional reference image).
     *
     * @param {string} prompt
     * @param {number} seed
     * @param {string|null} inputImageBase64 - Optional reference image
     * @param {object} options - { aspect_ratio, negative_prompt, lite, mod_content, mod_input, mod_output, structured_prompt }
     */
    async generate(prompt, seed, inputImageBase64 = null, options = {}) {
        console.log('[TRACE] api.generate called', { promptSnippet: prompt?.substring(0, 20), seed, optionsKeys: Object.keys(options) });
        const endpoint = options.lite ? '/image/generate_lite' : '/image/generate';

        const body = { seed };
        if (options.structured_prompt) {
            let sp = options.structured_prompt;
            // Bria /image/generate expects structured_prompt as a JSON *string*, not an object
            if (typeof sp === 'object') {
                sp = JSON.stringify(sp);
            }
            body.structured_prompt = sp;
            if (prompt) body.prompt = prompt;
        } else {
            body.prompt = prompt;
        }

        if (options.aspect_ratio) body.aspect_ratio = options.aspect_ratio;
        if (options.resolution) body.resolution = options.resolution;
        if (options.negative_prompt) body.negative_prompt = options.negative_prompt;

        body.prompt_content_moderation = !!options.mod_content;
        body.visual_input_content_moderation = !!options.mod_input;
        body.visual_output_content_moderation = !!options.mod_output;
        body.ip_signal = !!options.ip_signal;

        if (inputImageBase64) {
            const raw = inputImageBase64.replace(/^data:image\/\w+;base64,/, '');
            body.images = [raw];
        }

        const data = await briaRequest(endpoint, body);
        const imageUrl = data.result?.image_url;
        if (!imageUrl) throw new Error('No image returned from API.');

        const base64 = await fetchImageAsBase64(imageUrl);

        return {
            base64,
            seed: data.result?.seed ?? seed,
            structured_prompt: data.result?.structured_prompt || data.result?.structured_instruction || options.structured_prompt || null,
            imageUrl
        };
    },


    /**
     * Edit an image based on source image + prompt/instruction.
     * Uses /v2/image/edit.
     */
    async edit(prompt, imageBase64, seed, options = {}) {
        console.log('[TRACE] api.edit called', { promptSnippet: prompt?.substring(0, 20), seed, optionsKeys: Object.keys(options) });
        const endpoint = '/image/edit';
        const raw = imageBase64.replace(/^data:image\/\w+;base64,/, '');

        const body = {
            images: [raw],
            seed: seed
        };

        // Standard options
        body.prompt_content_moderation = !!options.mod_content;
        body.visual_input_content_moderation = !!options.mod_input;
        body.visual_output_content_moderation = !!options.mod_output;
        body.ip_signal = !!options.ip_signal;

        if (options.structured_instruction || options.structured_prompt) {
            let si = options.structured_instruction || options.structured_prompt;
            // Bria /image/edit expects structured_instruction as a JSON *string*, not an object
            if (typeof si === 'object') {
                si = JSON.stringify(si);
            }
            body.structured_instruction = si;
        } else {
            body.instruction = prompt;
        }

        const data = await briaRequest(endpoint, body);
        const imageUrl = data.result?.image_url;
        if (!imageUrl) throw new Error('No image returned from API.');

        const base64 = await fetchImageAsBase64(imageUrl);

        return {
            base64,
            seed: data.result?.seed || seed,
            structured_prompt: data.result?.structured_instruction || data.result?.structured_prompt || options.structured_instruction || options.structured_prompt || null,
            imageUrl
        };
    },

    async enhance(imageBase64, seed = null, options = {}) {
        const endpoint = '/image/edit/enhance';
        const raw = imageBase64.replace(/^data:image\/\w+;base64,/, '');

        const body = { image: raw };
        if (seed !== null) body.seed = seed;
        body.prompt_content_moderation = !!options.mod_content;
        body.ip_signal = !!options.ip_signal;
        body.visual_input_content_moderation = !!options.mod_input;
        body.visual_output_content_moderation = !!options.mod_output;

        const data = await briaRequest(endpoint, body, 'POST', { noSync: true });
        const imageUrl = data.result?.image_url;
        if (!imageUrl) throw new Error('No image returned from API.');

        const base64 = await fetchImageAsBase64(imageUrl);

        return {
            base64,
            seed: data.result?.seed || seed,
            structured_prompt: data.result?.structured_instruction || data.result?.structured_prompt || options.structured_prompt || null,
            imageUrl
        };
    },

    /**
     * Increase image resolution by a factor of 2 or 4.
     * Uses Bria's /increase_resolution endpoint.
     * @param {string} imageBase64 - Base64 encoded image (or URL)
     * @param {number} scaleFactor - 2 or 4
     */
    async increaseResolution(imageBase64, scaleFactor = 2) {
        const raw = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const body = {
            image: raw,
            desired_increase: parseInt(scaleFactor, 10)  // must be integer (2 or 4)
        };

        // Uses async polling (202) — same as other Bria endpoints
        const data = await briaRequest('/image/edit/increase_resolution', body, 'POST');
        const imageUrl = data.result?.image_url;
        if (!imageUrl) throw new Error('No image URL returned from Increase Resolution API.');

        const base64 = await fetchImageAsBase64(imageUrl);
        return {
            base64,
            seed: data.result?.seed || null,
            imageUrl
        };
    },

    /**
     * Generate a structured prompt or instruction only (no image).
     */
    async generateStructuredPrompt(promptOrInstruction, inputImageBase64 = null, existingStructuredPrompt = null, options = {}) {
        let endpoint = '/structured_prompt/generate';
        const body = {};

        if (existingStructuredPrompt && promptOrInstruction) {
            // Refinement of a Text-to-Image prompt
            body.structured_prompt = existingStructuredPrompt;
            body.prompt = promptOrInstruction;
        } else if (inputImageBase64) {
            // Image-to-Image / Edit workflow
            endpoint = '/structured_instruction/generate';
            const raw = inputImageBase64.replace(/^data:image\/\w+;base64,/, '');
            body.images = [raw];
            if (promptOrInstruction) body.instruction = promptOrInstruction;
        } else {
            // New Text-to-Image prompt
            body.prompt = promptOrInstruction;
        }

        body.prompt_content_moderation = !!options.mod_content;
        body.ip_signal = !!options.ip_signal;
        body.visual_input_content_moderation = !!options.mod_input;
        body.visual_output_content_moderation = !!options.mod_output;

        // NOTE: Do NOT use forceSync for structured_prompt endpoints — it triggers an UNKNOWN/500 on Bria's side.
        // Use async polling instead.
        const data = await briaRequest(endpoint, body, 'POST');

        // The result shape from /structured_prompt/generate (after polling COMPLETED):
        // data.result.structured_prompt or data.result.structured_instruction
        // OR if it comes back directly: data.structured_prompt
        const sp = data.result?.structured_prompt
            || data.result?.structured_instruction
            || data.structured_prompt
            || data.structured_instruction
            || null;

        console.log('[TRACE] generateStructuredPrompt result keys:', Object.keys(data.result || data));

        return {
            structured_prompt: sp,
            seed: data.result?.seed || data.seed || null
        };
    },

    /**
     * Generate optimized structured prompt from a diff (user edited the JSON).
     *
     * @param {string} originalPrompt - Original structured_prompt JSON string
     * @param {string} editedPrompt - User-modified structured_prompt JSON string
     * @param {number} seed
     * @returns {Promise<{structured_prompt: string, seed: number}>}
     */
    async generateStructuredPromptFromDiff(originalPrompt, editedPrompt, seed, options = {}) {
        const body = {
            structured_prompt: originalPrompt,
            user_adjusted_structured_prompt: editedPrompt,
            seed
        };

        body.prompt_content_moderation = !!options.mod_content;
        body.ip_signal = !!options.ip_signal;
        body.visual_input_content_moderation = !!options.mod_input;
        body.visual_output_content_moderation = !!options.mod_output;

        // NOTE: Do NOT use forceSync for diff endpoints either — same UNKNOWN/500 behavior.
        const data = await briaRequest('/structured_prompt/generate_from_diff', body, 'POST');

        const sp = data.result?.structured_prompt
            || data.result?.structured_instruction
            || data.structured_prompt
            || data.structured_instruction
            || null;

        return {
            structured_prompt: sp,
            seed: data.result?.seed || data.seed || seed
        };
    }
};

export default api;
