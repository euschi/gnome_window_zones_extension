// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Linked resize: while dragging the border of a window, the windows side by
// side on that edge follow the border in real time (they grow when the window
// shrinks and vice versa), keeping the gap that was between them.
//
// On release, windows snapped to a zone stay snapped with the new size, so when
// dragged away they still return to their original size.

import GLib from 'gi://GLib';

import {GrabOpBits, frameRectEquals, isTileable, overlap} from './utils.js';

// Minimum size a linked window can be shrunk to
const MIN_SIZE = 120;

// Time after the release during which the sizes applied by the client are
// still followed
const SETTLE_TIME_MS = 400;

const EDGES = [
    {bit: GrabOpBits.WEST, side: 'left'},
    {bit: GrabOpBits.EAST, side: 'right'},
    {bit: GrabOpBits.NORTH, side: 'top'},
    {bit: GrabOpBits.SOUTH, side: 'bottom'},
];

const OPPOSITE = {left: 'right', right: 'left', top: 'bottom', bottom: 'top'};

function edgeOf(r, side) {
    switch (side) {
    case 'left':
        return r.x;
    case 'right':
        return r.x + r.width;
    case 'top':
        return r.y;
    default:
        return r.y + r.height;
    }
}

export class LinkedResize {
    constructor(settings, zoneManager) {
        this._settings = settings;
        this._zones = zoneManager;
        this._resize = null;

        global.display.connectObject(
            'grab-op-begin', (_d, window, op) => this._onGrabBegin(window, op),
            'grab-op-end', (_d, window) => this._onGrabEnd(window),
            this);
    }

    destroy() {
        global.display.disconnectObject(this);
        this._stop();
    }

    _onGrabBegin(window, op) {
        this._stop();
        if (!this._settings.get_boolean('linked-resize-enabled'))
            return;
        if (!(op & GrabOpBits.WINDOW) || !(op & GrabOpBits.EDGES) || !isTileable(window))
            return;

        const rect = window.get_frame_rect();
        const tolerance = this._settings.get_int('zone-gap') + 12;
        // Windows already handled by Mutter (side-by-side half screen)
        const tileMatch = window.get_tile_match();
        const others = this._zones.windowsOnMonitor(window.get_monitor())
            .filter(w => w !== window && w !== tileMatch);

        const links = [];
        for (const {bit, side} of EDGES) {
            if (!(op & bit))
                continue;
            const edge = edgeOf(rect, side);
            const opposite = OPPOSITE[side];
            const horizontal = side === 'left' || side === 'right';
            for (const other of others) {
                const r = other.get_frame_rect();
                const otherEdge = edgeOf(r, opposite);
                // The neighbor must be on the side of the dragged border
                const beyond = side === 'right' || side === 'bottom'
                    ? otherEdge >= edge - 2 : otherEdge <= edge + 2;
                if (!beyond || Math.abs(otherEdge - edge) > tolerance)
                    continue;
                const shared = horizontal
                    ? overlap(rect.y, rect.height, r.y, r.height)
                    : overlap(rect.x, rect.width, r.x, r.width);
                if (shared < Math.min(horizontal ? rect.height : rect.width,
                    horizontal ? r.height : r.width) / 2)
                    continue;
                if (other.get_maximize_flags())
                    continue;
                links.push({
                    window: other, side, rect: r, offset: otherEdge - edge,
                });
            }
        }
        if (!links.length)
            return;

        // Check the snap state now: at the end of the resize the windows no
        // longer match the zone until we update it
        this._zones.snapState(window);
        for (const link of links)
            this._zones.snapState(link.window);

        this._resize = {window, links};
        window.connectObject(
            'size-changed', () => this._follow(),
            'position-changed', () => this._follow(),
            'unmanaged', () => this._stop(),
            this);
        for (const link of links)
            link.window.connectObject('unmanaged', () => this._unlink(link.window), this);
    }

    _unlink(window) {
        if (!this._resize)
            return;
        window.disconnectObject(this);
        this._resize.links = this._resize.links.filter(l => l.window !== window);
    }

    // Move the opposite border of each neighbor according to the dragged border
    _follow() {
        const resize = this._resize;
        if (!resize)
            return;
        const current = resize.window.get_frame_rect();
        const rect = this._clamp(current, resize.links);
        resize.rect = rect;
        if (!frameRectEquals(rect, current))
            resize.window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);

        for (const link of resize.links) {
            const {window, side, rect: r, offset} = link;
            const target = edgeOf(rect, side) + offset;
            let {x, y, width, height} = r;
            switch (OPPOSITE[side]) {
            case 'left': // the neighbor is on the right: move its left border
                x = Math.min(target, r.x + r.width - MIN_SIZE);
                width = r.x + r.width - x;
                break;
            case 'right':
                width = Math.max(MIN_SIZE, target - r.x);
                break;
            case 'top':
                y = Math.min(target, r.y + r.height - MIN_SIZE);
                height = r.y + r.height - y;
                break;
            default:
                height = Math.max(MIN_SIZE, target - r.y);
            }
            link.requested = {x, y, width, height};
            if (!frameRectEquals(window.get_frame_rect(), link.requested))
                window.move_resize_frame(false, x, y, width, height);
        }
    }

    // The dragged border stops when a neighbor reaches the minimum size,
    // instead of going over it
    _clamp(current, links) {
        let left = current.x, top = current.y;
        let right = current.x + current.width, bottom = current.y + current.height;
        for (const {side, rect: r, offset} of links) {
            switch (side) {
            case 'right':
                right = Math.min(right, r.x + r.width - MIN_SIZE - offset);
                break;
            case 'left':
                left = Math.max(left, r.x + MIN_SIZE - offset);
                break;
            case 'bottom':
                bottom = Math.min(bottom, r.y + r.height - MIN_SIZE - offset);
                break;
            default:
                top = Math.max(top, r.y + MIN_SIZE - offset);
            }
        }
        return {x: left, y: top, width: right - left, height: bottom - top};
    }

    _onGrabEnd(window) {
        const resize = this._resize;
        if (!resize || resize.window !== window)
            return;
        // The client applies the last drag size even after the release: keep
        // following it (and stopping it at the limit) for a while
        this._follow();
        resize.settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_TIME_MS, () => {
            resize.settleId = 0;
            this._follow();
            this._zones.updateTarget(window, resize.rect);
            // The neighbor's client may not have applied the size yet
            for (const link of resize.links) {
                if (link.requested)
                    this._zones.updateTarget(link.window, link.requested);
            }
            this._stop();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stop() {
        const resize = this._resize;
        if (!resize)
            return;
        this._resize = null;
        if (resize.settleId)
            GLib.source_remove(resize.settleId);
        resize.window.disconnectObject(this);
        for (const link of resize.links)
            link.window.disconnectObject(this);
    }
}
