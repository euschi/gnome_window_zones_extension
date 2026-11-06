// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Layout model, in plain JavaScript: used by both the extension and the
// preferences (which run in a separate GTK process and can't import the Shell
// modules).
//
// A layout is a tree of splits:
//   {id, name, root: node}
//   node = {zone: true}
//        | {dir: 'cols'|'rows', sizes: [fractions], children: [node, ...]}
// 'cols' places the children side by side from left to right, 'rows' stacks
// them from top to bottom. Zones are numbered in depth-first visit order.

// Mark strings for xgettext without translating them here: the translation
// happens where they are displayed.
const N_ = s => s;

export const MIN_SIZE = 0.05;

export const zone = () => ({zone: true});

const split = (dir, sizes, children) => ({dir, sizes, children});

const even = n => Array(n).fill(1 / n);

const cols = (...children) => split('cols', even(children.length), children);

const rows = (...children) => split('rows', even(children.length), children);

export const BUILTIN_LAYOUTS = [
    {id: 'halves', name: N_('Halves'), root: cols(zone(), zone())},
    {id: 'thirds', name: N_('Thirds'), root: cols(zone(), zone(), zone())},
    {id: 'grid-2x2', name: N_('Grid 2×2'), root: rows(cols(zone(), zone()), cols(zone(), zone()))},
    {id: 'third-two-thirds', name: N_('One Third + Two Thirds'),
        root: split('cols', [1 / 3, 2 / 3], [zone(), zone()])},
    {id: 'two-thirds-third', name: N_('Two Thirds + One Third'),
        root: split('cols', [2 / 3, 1 / 3], [zone(), zone()])},
    {id: 'main-side', name: N_('Main + Side Stack'),
        root: split('cols', [0.6, 0.4], [zone(), rows(zone(), zone())])},
    {id: 'priority', name: N_('Priority'),
        root: split('cols', [0.25, 0.5, 0.25], [zone(), zone(), zone()])},
    {id: 'four-columns', name: N_('Four Columns'), root: cols(zone(), zone(), zone(), zone())},
    {id: 'grid-3x2', name: N_('Grid 3×2'),
        root: rows(cols(zone(), zone(), zone()), cols(zone(), zone(), zone()))},
];

const BUILTIN_IDS = new Set(BUILTIN_LAYOUTS.map(l => l.id));

// Zone rectangles as fractions of the given rectangle (default: the whole area)
export function zonesFromTree(node, rect = {x: 0, y: 0, w: 1, h: 1}, out = []) {
    if (node.zone) {
        out.push({...rect});
        return out;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
        const size = node.sizes[i];
        const sub = node.dir === 'cols'
            ? {x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h}
            : {x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h};
        zonesFromTree(child, sub, out);
        offset += size;
    });
    return out;
}

// Zone rectangles in pixels in a thumbnail, with `gap` between one zone and the next
export function thumbnailRects(root, width, height, gap) {
    return zonesFromTree(root).map(f => ({
        x: Math.round(f.x * width + gap / 2),
        y: Math.round(f.y * height + gap / 2),
        width: Math.max(1, Math.round(f.w * width - gap)),
        height: Math.max(1, Math.round(f.h * height - gap)),
    }));
}

export function countZones(node) {
    return node.zone ? 1 : node.children.reduce((n, c) => n + countZones(c), 0);
}

// Normalize a node read from JSON; return null if it isn't valid
function sanitizeNode(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 16)
        return null;
    if (node.zone)
        return zone();
    if (!['cols', 'rows'].includes(node.dir) || !Array.isArray(node.children) ||
        node.children.length < 2)
        return null;
    const children = node.children.map(c => sanitizeNode(c, depth + 1));
    if (children.some(c => !c))
        return null;
    let sizes = Array.isArray(node.sizes) && node.sizes.length === children.length
        ? node.sizes.map(s => Number(s) > 0 ? Number(s) : MIN_SIZE)
        : even(children.length);
    const total = sizes.reduce((a, b) => a + b, 0);
    sizes = sizes.map(s => s / total);
    return {dir: node.dir, sizes, children};
}

export function parseCustomLayouts(json) {
    let list;
    try {
        list = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(list))
        return [];
    const layouts = [];
    for (const l of list) {
        const root = sanitizeNode(l?.root);
        if (!root || typeof l.id !== 'string' || BUILTIN_IDS.has(l.id))
            continue;
        layouts.push({id: l.id, name: String(l.name ?? '') || N_('Untitled'), root});
    }
    return layouts;
}

function roundNode(node) {
    if (node.zone)
        return zone();
    return {
        dir: node.dir,
        sizes: node.sizes.map(s => Math.round(s * 10000) / 10000),
        children: node.children.map(roundNode),
    };
}

export function serializeCustomLayouts(layouts) {
    return JSON.stringify(layouts.map(({id, name, root}) => ({id, name, root: roundNode(root)})));
}

export function newLayoutId() {
    return `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function cloneNode(node) {
    return JSON.parse(JSON.stringify(node));
}

export function parseJsonObject(json) {
    try {
        const obj = JSON.parse(json);
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
        return {};
    }
}

// Unified access to built-in + custom layouts from GSettings
export function allLayouts(settings) {
    return [...BUILTIN_LAYOUTS, ...parseCustomLayouts(settings.get_string('custom-layouts'))];
}
