// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

// Meta.GrabOp bits (META_GRAB_OP_WINDOW_BASE, _KEYBOARD, directions)
export const GrabOpBits = {
    WINDOW: 1,
    KEYBOARD: 256,
    WEST: 4096,
    EAST: 8192,
    SOUTH: 16384,
    NORTH: 32768,
    EDGES: 4096 | 8192 | 16384 | 32768,
};

export function isPointerMove(op) {
    return (op & GrabOpBits.WINDOW) && !(op & GrabOpBits.KEYBOARD) &&
        !(op & GrabOpBits.EDGES);
}

export function frameRectEquals(a, b, tolerance = 0) {
    return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance &&
        Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

export const MODIFIER_MASKS = {
    shift: Clutter.ModifierType.SHIFT_MASK,
    ctrl: Clutter.ModifierType.CONTROL_MASK,
    alt: Clutter.ModifierType.MOD1_MASK,
    super: Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK,
};

export function isMaximized(window) {
    return window.get_maximize_flags() === Meta.MaximizeFlags.BOTH;
}

// Regular windows that make sense to place in zones. For Mutter a maximized
// window isn't resizable, but it becomes so again as soon as it stops being one.
export function isTileable(window) {
    return window && !window.is_skip_taskbar() && !window.minimized &&
        window.get_window_type() === Meta.WindowType.NORMAL &&
        (window.allows_resize() || isMaximized(window)) && !window.is_fullscreen();
}

// Connector name (e.g. "DP-1") of each monitor index, to remember the layout of
// a monitor even if the monitor order changes
export function monitorConnectors() {
    const manager = global.backend.get_monitor_manager();
    const map = new Map();
    for (const logical of manager.get_logical_monitors()) {
        for (const monitor of logical.get_monitors()) {
            const connector = monitor.get_connector();
            const index = manager.get_monitor_for_connector(connector);
            if (index >= 0 && !map.has(index))
                map.set(index, connector);
        }
    }
    return map;
}

export function rectContains(r, x, y) {
    return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

// Length of the part shared by two segments (negative if they are apart)
export function overlap(s1, l1, s2, l2) {
    return Math.min(s1 + l1, s2 + l2) - Math.max(s1, s2);
}

export function overlapArea(a, b) {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

// Two rectangles side by side (or stacked) within `tolerance` pixels of each
// other and overlapping by at least half on the other axis
export function areAdjacent(a, b, tolerance) {
    const near = (end, start) => Math.abs(end - start) <= tolerance;
    if ((near(a.x + a.width, b.x) || near(b.x + b.width, a.x)) &&
        overlap(a.y, a.height, b.y, b.height) >= Math.min(a.height, b.height) / 2)
        return true;
    return (near(a.y + a.height, b.y) || near(b.y + b.height, a.y)) &&
        overlap(a.x, a.width, b.x, b.width) >= Math.min(a.width, b.width) / 2;
}
