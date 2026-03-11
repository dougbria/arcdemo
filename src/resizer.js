/**
 * Simple Resizer utility for vertical panes in VGL Studio.
 */
export function initResizers(configs = []) {
    configs.forEach(config => {
        setupResizer(config.resizerId, config.prevId, config.nextId, config.mode);
    });
}

function setupResizer(resizerId, prevId, nextId, mode = 'left') {
    const resizer = document.getElementById(resizerId);
    const prevEl = document.getElementById(prevId);
    const nextEl = document.getElementById(nextId);

    if (!resizer || !prevEl || !nextEl) return;

    let startX, startWidthNext, startWidthPrev;

    resizer.addEventListener('mousedown', (e) => {
        startX = e.clientX;
        startWidthNext = nextEl.offsetWidth;
        startWidthPrev = prevEl.offsetWidth;

        resizer.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        const delta = e.clientX - startX;

        // If nextId is a sidebar, we are resizing from the left of it (delta is negative when dragging left)
        if (nextId === 'reel-sidebar' || nextId === 'json-sidebar') {
            const newWidth = startWidthNext - delta;
            if (newWidth > 150 && newWidth < 800) {
                nextEl.style.width = `${newWidth}px`;
            }
        } else if (prevId === 'canvas-area') {
            // Alternatively, if we are resizing the reel from the canvas area's perspective
            const newWidth = startWidthNext - delta;
            if (newWidth > 150 && newWidth < 800) {
                nextEl.style.width = `${newWidth}px`;
            }
        }
    }

    function onMouseUp() {
        resizer.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    }
}
