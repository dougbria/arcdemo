/* ============================================================
   actions.js — Shared application actions
   ============================================================ */

import state from './state.js';
import api from './api.js';
import { createThumbnail, showToast, generateUUID } from './utils.js';

/**
 * Handle image enhancement (upscale to 4MP via Creative Enhancer).
 */
export async function enhanceImage(imageId, options = {}) {
    const project = state.getActiveProject();
    const img = project.images.find(i => i.id === imageId);
    if (!img) return;

    state.setLoading(true, 'Creative Enhancer — processing…');
    try {
        const result = await api.enhance(img.base64, img.seed, {
            mod_content: options.modContent,
            mod_output: options.modOutput,
            ip_signal: options.ipSignal
        });

        const thumbnail = await createThumbnail(result.base64, 200);
        await state.addImage({ ...result, thumbnail }, img.prompt, 'enhance', generateUUID(), img.id);
        showToast('Creative Enhancer complete!');
    } catch (err) {
        console.error('Enhance error:', err);
        state.setError('Creative Enhancer failed: ' + err.message);
    } finally {
        state.setLoading(false);
    }
}

/**
 * Increase image resolution by 2x or 4x.
 */
export async function increaseResolution(imageId, scaleFactor = 2) {
    const project = state.getActiveProject();
    const img = project?.images.find(i => i.id === imageId);
    if (!img) return;

    state.setLoading(true, `Increasing resolution ${scaleFactor}×…`);
    try {
        const result = await api.increaseResolution(img.base64, scaleFactor);

        const thumbnail = await createThumbnail(result.base64, 200);
        await state.addImage(
            { ...result, thumbnail, structured_prompt: img.structured_prompt },
            img.prompt,
            'enhance',
            generateUUID(),
            img.id
        );
        showToast(`Resolution increased ${scaleFactor}×!`);
    } catch (err) {
        console.error('Increase resolution error:', err);
        state.setError(`Increase resolution failed: ${err.message}`);
    } finally {
        state.setLoading(false);
    }
}
