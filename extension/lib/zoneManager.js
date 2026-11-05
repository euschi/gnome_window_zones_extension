// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Zone geometry of each monitor and window placement.
// For each window placed in a zone, remembers the original size (to restore it
// when dragged away) and the occupied zone (for Snap Assist and for moving
// between zones with the keyboard).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    BUILTIN_LAYOUTS, allLayouts, parseJsonObject, zonesFromTree,
} from './layoutModel.js';
import {
    areAdjacent, frameRectEquals, isMaximized, isTileable, monitorConnectors,
    overlapArea, rectContains,
} from './utils.js';

// On Wayland the client applies the new size asynchronously: for a while after
// the placement the window may not be where we put it yet, but it has to be
// considered snapped
const SETTLE_TIME_US = 1500 * 1000;

export class ZoneManager {
    constructor(settings) {
        this._settings = settings;
        this._snapped = new Map(); // window → {monitor, zone, target, orig}
        this._layouts = allLayouts(settings);
        settings.connectObject('changed::custom-layouts', () => {
            this._layouts = allLayouts(settings);
        }, this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        for (const window of this._snapped.keys())
            window.disconnectObject(this);
        this._snapped.clear();
    }

    get layouts() {
        return this._layouts;
    }

    layoutForMonitor(monitor) {
        const active = parseJsonObject(this._settings.get_string('active-layouts'));
        const connector = monitorConnectors().get(monitor);
        const id = active[connector] ?? this._settings.get_string('default-layout');
        return this._layouts.find(l => l.id === id) ?? BUILTIN_LAYOUTS[0];
    }

    setLayoutForMonitor(monitor, id) {
        const connector = monitorConnectors().get(monitor);
        if (connector === undefined)
            return;
        const active = parseJsonObject(this._settings.get_string('active-layouts'));
        active[connector] = id;
        this._settings.set_string('active-layouts', JSON.stringify(active));
    }

    workArea(monitor) {
        return Main.layoutManager.getWorkAreaForMonitor(monitor);
    }

    // Zones in pixels: `rect` is the zone area (for the pointer), `target` is
    // the rectangle the window goes into (with the gap around it)
    zonesForLayout(layout, monitor) {
        const area = this.workArea(monitor);
        const half = this._settings.get_int('zone-gap') / 2;
        return zonesFromTree(layout.root).map((f, index) => {
            const x1 = Math.round(area.x + f.x * area.width);
            const y1 = Math.round(area.y + f.y * area.height);
            const x2 = Math.round(area.x + (f.x + f.w) * area.width);
            const y2 = Math.round(area.y + (f.y + f.h) * area.height);
            const rect = {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
            return {index, rect, target: this._inset(rect, area, half)};
        });
    }

    zonesForMonitor(monitor) {
        return this.zonesForLayout(this.layoutForMonitor(monitor), monitor);
    }

    // Gap of `half` between neighboring zones and of `2 * half` towards the
    // screen edges, so that all the gaps end up equal
    _inset(rect, area, half) {
        const left = rect.x === area.x ? 2 * half : half;
        const top = rect.y === area.y ? 2 * half : half;
        const right = rect.x + rect.width === area.x + area.width ? 2 * half : half;
        const bottom = rect.y + rect.height === area.y + area.height ? 2 * half : half;
        return {
            x: Math.round(rect.x + left),
            y: Math.round(rect.y + top),
            width: Math.max(1, Math.round(rect.width - left - right)),
            height: Math.max(1, Math.round(rect.height - top - bottom)),
        };
    }

    // Quarter of the screen for snapping to corners
    quarterRect(monitor, corner) {
        const area = this.workArea(monitor);
        const w = Math.round(area.width / 2);
        const h = Math.round(area.height / 2);
        const rect = {
            x: corner.endsWith('left') ? area.x : area.x + w,
            y: corner.startsWith('top') ? area.y : area.y + h,
            width: corner.endsWith('left') ? w : area.width - w,
            height: corner.startsWith('top') ? h : area.height - h,
        };
        return this._inset(rect, area, this._settings.get_int('zone-gap') / 2);
    }

    zoneAt(monitor, x, y) {
        return this.zonesForMonitor(monitor).find(z => rectContains(z.rect, x, y)) ?? null;
    }

    placeInZone(window, monitor, zoneIndex) {
        const zone = this.zonesForMonitor(monitor)[zoneIndex];
        if (!zone)
            return false;
        this.placeInRect(window, zone.target, {monitor, zone: zoneIndex});
        return true;
    }

    placeInRect(window, target, {monitor = window.get_monitor(), zone = -1} = {}) {
        if (!isTileable(window))
            return;

        const previous = this._snapped.get(window);
        const current = window.get_frame_rect();
        // The original size is the one from before the first snap (the position
        // doesn't matter: the window may have just been dragged)
        const sameSize = previous &&
            Math.abs(current.width - previous.target.width) <= 4 &&
            Math.abs(current.height - previous.target.height) <= 4;
        let orig = {width: current.width, height: current.height};
        if (sameSize) {
            orig = previous.orig;
        } else if (isMaximized(window)) {
            // Mutter doesn't expose the size from before the maximization
            orig = {
                width: Math.round(current.width * 2 / 3),
                height: Math.round(current.height * 2 / 3),
            };
        }

        if (window.get_maximize_flags())
            window.unmaximize();
        window.move_resize_frame(true, target.x, target.y, target.width, target.height);

        if (!previous)
            window.connectObject('unmanaged', () => this.forget(window), this);
        this._snapped.set(window, {
            monitor, zone, target: {...target}, orig, placedAt: GLib.get_monotonic_time(),
        });
    }

    forget(window) {
        if (!this._snapped.has(window))
            return;
        window.disconnectObject(this);
        this._snapped.delete(window);
    }

    // Snap state, valid only if the window is still where we put it (if the
    // user resized it by hand it is no longer snapped)
    snapState(window) {
        const state = this._snapped.get(window);
        if (!state)
            return null;
        if (GLib.get_monotonic_time() - state.placedAt < SETTLE_TIME_US)
            return state;
        if (!frameRectEquals(window.get_frame_rect(), state.target, 4) ||
            window.get_maximize_flags()) {
            this.forget(window);
            return null;
        }
        return state;
    }

    // Snapped window resized together with its neighbors: it stays snapped to
    // the same zone with the new size (and the previous original size). The
    // state must be checked with snapState() before the resize.
    updateTarget(window, rect) {
        const state = this._snapped.get(window);
        if (!state)
            return;
        const {x, y, width, height} = rect;
        state.target = {x, y, width, height};
        state.placedAt = GLib.get_monotonic_time();
    }

    // Restore the original size keeping the pointer in the same relative
    // position of the window
    restoreSize(window, pointerX, pointerY) {
        const state = this._snapped.get(window);
        if (!state)
            return;
        this.forget(window);

        const rect = window.get_frame_rect();
        const relX = (pointerX - rect.x) / rect.width;
        const relY = Math.min(pointerY - rect.y, state.orig.height / 2);
        const {width, height} = state.orig;
        const area = this.workArea(window.get_monitor());
        let x = Math.round(pointerX - relX * width);
        let y = Math.round(pointerY - Math.max(0, relY));
        x = Math.max(area.x - width + 50, Math.min(x, area.x + area.width - 50));
        y = Math.max(area.y, Math.min(y, area.y + area.height - 50));
        window.move_resize_frame(true, x, y, width, height);
    }

    // Zones of the monitor occupied by snapped windows (on the active workspace)
    occupiedZones(monitor) {
        const workspace = global.workspace_manager.get_active_workspace();
        const occupied = new Set();
        for (const window of [...this._snapped.keys()]) {
            if (window.get_workspace() !== workspace || window.minimized)
                continue;
            const state = this.snapState(window);
            if (state && state.monitor === monitor && state.zone >= 0)
                occupied.add(state.zone);
        }
        return occupied;
    }

    windowsOnMonitor(monitor) {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .filter(w => w.get_monitor() === monitor && isTileable(w));
    }

    // Zone the window is in: the snapped one or, otherwise, the one it
    // overlaps the most
    currentZone(window) {
        const monitor = window.get_monitor();
        const state = this.snapState(window);
        if (state && state.monitor === monitor && state.zone >= 0)
            return state.zone;
        const rect = window.get_frame_rect();
        let best = -1, bestArea = 0;
        for (const zone of this.zonesForMonitor(monitor)) {
            const area = overlapArea(rect, zone.rect);
            if (area > bestArea) {
                best = zone.index;
                bestArea = area;
            }
        }
        return best;
    }

    moveInDirection(window, direction) {
        if (!isTileable(window))
            return;
        const monitor = window.get_monitor();
        const zones = this.zonesForMonitor(monitor);
        const state = this.snapState(window);
        const fromIndex = state && state.monitor === monitor ? state.zone : -1;

        // Window not snapped: it goes to the zone closest to that side
        if (fromIndex < 0) {
            const target = this._edgeZone(zones, direction, window.get_frame_rect());
            if (target)
                this.placeInZone(window, monitor, target.index);
            return;
        }

        const next = this._neighbour(zones, zones[fromIndex], direction);
        if (next) {
            this.placeInZone(window, monitor, next.index);
            return;
        }

        // Past the edge: closest zone of the next monitor
        const metaDirection = {
            left: Meta.DisplayDirection.LEFT, right: Meta.DisplayDirection.RIGHT,
            up: Meta.DisplayDirection.UP, down: Meta.DisplayDirection.DOWN,
        }[direction];
        const other = global.display.get_monitor_neighbor_index(monitor, metaDirection);
        if (other < 0)
            return;
        const opposite = {left: 'right', right: 'left', up: 'down', down: 'up'}[direction];
        const target = this._edgeZone(this.zonesForMonitor(other), opposite,
            zones[fromIndex].rect);
        if (target)
            this.placeInZone(window, other, target.index);
    }

    _center(r) {
        return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    }

    // Adjacent zone in the given direction: the closest among those on that
    // side, preferring the ones aligned on the other axis
    _neighbour(zones, from, direction) {
        const c = this._center(from.rect);
        const horizontal = direction === 'left' || direction === 'right';
        let best = null, bestScore = Infinity;
        for (const zone of zones) {
            if (zone === from)
                continue;
            const z = this._center(zone.rect);
            const along = horizontal ? z.x - c.x : z.y - c.y;
            const across = horizontal ? z.y - c.y : z.x - c.x;
            const forward = direction === 'right' || direction === 'down' ? along : -along;
            if (forward <= 1)
                continue;
            const aligned = horizontal
                ? c.y >= zone.rect.y && c.y < zone.rect.y + zone.rect.height
                : c.x >= zone.rect.x && c.x < zone.rect.x + zone.rect.width;
            const score = forward + Math.abs(across) * 2 + (aligned ? 0 : 1e6);
            if (score < bestScore) {
                best = zone;
                bestScore = score;
            }
        }
        return best;
    }

    // Zone on the `direction` side of the area, the most aligned with the given rectangle
    _edgeZone(zones, direction, rect) {
        const c = this._center(rect);
        const horizontal = direction === 'left' || direction === 'right';
        const edgeOf = z => {
            if (direction === 'left')
                return -z.rect.x;
            if (direction === 'right')
                return z.rect.x + z.rect.width;
            if (direction === 'up')
                return -z.rect.y;
            return z.rect.y + z.rect.height;
        };
        const extreme = Math.max(...zones.map(edgeOf));
        const candidates = zones.filter(z => Math.abs(edgeOf(z) - extreme) <= 2);
        const distance = z => {
            const zc = this._center(z.rect);
            return horizontal ? Math.abs(zc.y - c.y) : Math.abs(zc.x - c.x);
        };
        candidates.sort((a, b) => distance(a) - distance(b));
        return candidates[0] ?? null;
    }

    // Distribute the windows of the monitor into the zones, most recent first
    applyToAll(monitor) {
        const zones = this.zonesForMonitor(monitor);
        const windows = this.windowsOnMonitor(monitor);
        windows.forEach((window, i) =>
            this.placeInZone(window, monitor, zones[i % zones.length].index));
    }

    // Windows of the same monitor side by side with the given window (the gap
    // between zones doesn't count)
    adjacentWindows(window) {
        if (!isTileable(window) || isMaximized(window))
            return [];
        const rect = window.get_frame_rect();
        const tolerance = this._settings.get_int('zone-gap') + 12;
        return this.windowsOnMonitor(window.get_monitor())
            .filter(w => w !== window && !isMaximized(w) &&
                areAdjacent(rect, w.get_frame_rect(), tolerance));
    }

    // Swap position and size of two windows; whichever was in a zone hands it
    // over to the other
    swapWindows(a, b) {
        if (!isTileable(a) || !isTileable(b))
            return;
        const placement = window => {
            const state = this.snapState(window);
            const {x, y, width, height} = state?.target ?? window.get_frame_rect();
            return {
                target: {x, y, width, height},
                monitor: state?.monitor ?? window.get_monitor(),
                zone: state?.zone ?? -1,
            };
        };
        const pa = placement(a), pb = placement(b);
        this.placeInRect(a, pb.target, pb);
        this.placeInRect(b, pa.target, pa);
    }

    toggleAlwaysOnTop(window) {
        if (!window)
            return;
        if (window.is_above())
            window.unmake_above();
        else
            window.make_above();
    }
}
