/**
 * JSON tree viewer for VGL Studio.
 * Handles nested objects, arrays, and multi-level diff-path highlighting.
 *
 * Highlight classes:
 *   .highlight-diff-ancestor  — container whose descendant changed (background tint)
 *   .highlight-diff-changed   — the leaf node whose value actually changed (bold + accent color)
 */

const SP_SECTION_ORDER = [
    'general',
    'objects',
    'lighting',
    'aesthetics',
    'photographic_characteristics',
    'text_render'
];

const SP_SECTION_LABELS = {
    general: 'General',
    objects: 'Objects',
    lighting: 'Lighting',
    aesthetics: 'Aesthetics',
    photographic_characteristics: 'Photographic Characteristics',
    text_render: 'Text Render'
};

// ── Canonical field orders for array-of-object sections ──────────────────
const OBJECT_FIELD_ORDER = [
    'description', 'location', 'relative_size', 'shape_and_color',
    'texture', 'appearance_details', 'relationship', 'orientation',
    'pose', 'expression', 'clothing', 'action', 'gender',
    'skin_tone_and_texture', 'number_of_objects'
];

const TEXT_RENDER_FIELD_ORDER = [
    'text', 'location', 'size', 'color', 'font', 'appearance_details'
];

/**
 * Sort an object's keys by a canonical order list.
 * Unknown keys go to the end in their original order.
 */
function sortObjectKeys(obj, order) {
    const ordered = {};
    // First: fields that appear in the canonical order
    for (const key of order) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            ordered[key] = obj[key];
        }
    }
    // Then: any remaining fields not in the order list
    for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
            ordered[key] = obj[key];
        }
    }
    return ordered;
}

/**
 * Reorder and group a structured_prompt object for display.
 */
export function transformStructuredPrompt(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

    const knownSections = new Set(SP_SECTION_ORDER.filter(k => k !== 'general'));
    const general = {};
    const sections = {};

    for (const [key, value] of Object.entries(data)) {
        if (knownSections.has(key)) {
            sections[key] = value;
        } else {
            general[key] = value;
        }
    }

    const result = {};
    for (const sectionKey of SP_SECTION_ORDER) {
        const label = SP_SECTION_LABELS[sectionKey] || sectionKey;
        if (sectionKey === 'general' && Object.keys(general).length > 0) {
            result[label] = general;
        } else if (sections[sectionKey] !== undefined) {
            result[label] = sections[sectionKey];
        }
    }

    return result;
}

/**
 * Render a JSON value as an interactive tree.
 *
 * @param {*}        data           - The data to display
 * @param {Element}  container      - DOM container to render into
 * @param {string[]} highlightPaths - Paths of leaf nodes that actually changed
 */
export function renderJsonTree(data, container, highlightPaths = []) {
    container.innerHTML = '';
    const tree = document.createElement('div');
    tree.className = 'json-tree';

    // Pre-compute ancestor paths so we can highlight parent containers.
    // e.g. if "Aesthetics.color_scheme" changed, "Aesthetics" is an ancestor.
    const changedSet = new Set(highlightPaths);
    const ancestorSet = new Set();
    for (const p of highlightPaths) {
        const parts = p.split('.');
        for (let i = 1; i < parts.length; i++) {
            ancestorSet.add(parts.slice(0, i).join('.'));
        }
    }

    /**
     * Choose the right field order for an object based on where it lives in the tree.
     * "objects" array items use OBJECT_FIELD_ORDER, "text_render" items use TEXT_RENDER_FIELD_ORDER.
     */
    function getSortOrder(path) {
        // path looks like "Objects.0" or "Text Render.2"
        const lower = path.toLowerCase();
        if (lower.startsWith('objects.') || lower === 'objects') return OBJECT_FIELD_ORDER;
        if (lower.startsWith('text render.') || lower === 'text render') return TEXT_RENDER_FIELD_ORDER;
        return null;
    }

    function createNode(key, value, level, path) {
        const fullPath = path ? `${path}.${key}` : String(key);
        const isChanged = changedSet.has(fullPath);
        const isAncestor = ancestorSet.has(fullPath);

        // ---- OBJECT ----
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // Sort keys if this is an array item that has a canonical order
            const sortOrder = getSortOrder(path);
            const sortedValue = sortOrder ? sortObjectKeys(value, sortOrder) : value;

            return buildCollapsible(key, '{', '}', level, fullPath, isAncestor || isChanged, () => {
                const children = document.createElement('div');
                children.className = 'tree-children';
                Object.entries(sortedValue).forEach(([k, v]) => {
                    children.appendChild(createNode(k, v, level + 1, fullPath));
                });
                return children;
            });
        }

        // ---- ARRAY ----
        if (Array.isArray(value)) {
            return buildCollapsible(key, '[', ']', level, fullPath, isAncestor || isChanged, () => {
                const children = document.createElement('div');
                children.className = 'tree-children';
                value.forEach((v, i) => {
                    children.appendChild(createNode(i, v, level + 1, fullPath));
                });
                return children;
            });
        }

        // ---- PRIMITIVE ----
        // Indentation is applied via a dedicated indent element (not padding on the
        // highlight wrapper) so that highlight backgrounds don't shift text position.
        const item = document.createElement('div');
        item.className = 'tree-item';

        // Indent spacer — lives outside the highlight wrapper so highlight never shifts it
        const indent = document.createElement('span');
        indent.className = 'tree-indent';
        indent.style.width = `${level * 16}px`;

        const keySpan = document.createElement('span');
        keySpan.className = 'tree-key';
        keySpan.textContent = key + ': ';

        const valueSpan = document.createElement('span');
        const type = value === null ? 'null' : typeof value;
        valueSpan.className = `tree-value tree-value-${type}`;
        valueSpan.textContent = JSON.stringify(value);

        if (isChanged) {
            item.classList.add('highlight-diff-changed');
        } else if (isAncestor) {
            item.classList.add('highlight-diff-ancestor');
        }

        item.appendChild(indent);
        item.appendChild(keySpan);
        item.appendChild(valueSpan);
        return item;
    }

    function buildCollapsible(key, openBracket, closeBracket, level, fullPath, isHighlighted, buildChildren) {
        const item = document.createElement('div');
        item.className = 'tree-item';

        if (isHighlighted) {
            item.classList.add('highlight-diff-ancestor');
        }

        // Indent spacer
        const indent = document.createElement('span');
        indent.className = 'tree-indent';
        indent.style.width = `${level * 16}px`;

        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        toggle.textContent = '▼';

        const keySpan = document.createElement('span');
        keySpan.className = 'tree-key';
        keySpan.textContent = key + ': ';

        const bracket = document.createElement('span');
        bracket.className = 'tree-bracket';
        bracket.textContent = openBracket;

        item.appendChild(indent);
        item.appendChild(toggle);
        item.appendChild(keySpan);
        item.appendChild(bracket);

        const children = buildChildren();

        toggle.onclick = () => {
            const isCollapsed = children.classList.toggle('hidden');
            toggle.textContent = isCollapsed ? '▶' : '▼';
        };

        const closingItem = document.createElement('div');
        closingItem.className = 'tree-closing';

        const closeIndent = document.createElement('span');
        closeIndent.className = 'tree-indent';
        closeIndent.style.width = `${level * 16}px`;
        closingItem.appendChild(closeIndent);
        closingItem.appendChild(document.createTextNode(closeBracket));

        const fragment = document.createDocumentFragment();
        fragment.appendChild(item);
        fragment.appendChild(children);
        fragment.appendChild(closingItem);
        return fragment;
    }

    if (Array.isArray(data)) {
        data.forEach((v, i) => tree.appendChild(createNode(i, v, 0, '')));
    } else if (typeof data === 'object' && data !== null) {
        Object.entries(data).forEach(([k, v]) => tree.appendChild(createNode(k, v, 0, '')));
    } else {
        tree.textContent = JSON.stringify(data);
    }

    container.appendChild(tree);
}
