// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Geometria delle zone di ogni monitor e posizionamento delle finestre.
// Ricorda, per ogni finestra sistemata in una zona, la dimensione originale
// (per ripristinarla quando la si trascina via) e la zona occupata (per lo
// Snap Assist e per lo spostamento tra zone da tastiera).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {
    BUILTIN_LAYOUTS, allLayouts, parseJsonObject, zonesFromTree,
} from './layoutModel.js';
import {
    areAdjacent, frameRectEquals, isTileable, monitorConnectors, overlapArea,
    rectContains,
} from './utils.js';

// Su Wayland il client applica la nuova dimensione in modo asincrono: per un
// po' dopo il posizionamento la finestra può non essere ancora dove l'abbiamo
// messa, ma va considerata agganciata
const SETTLE_TIME_US = 1500 * 1000;

export class ZoneManager extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._snapped = new Map(); // finestra → {monitor, zone, target, orig}
        this._reloadLayouts();
        settings.connectObject(
            'changed::custom-layouts', () => this._reloadLayouts(),
            'changed::active-layouts', () => this.emit('layouts-changed'),
            'changed::default-layout', () => this.emit('layouts-changed'),
            this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        for (const window of this._snapped.keys())
            window.disconnectObject(this);
        this._snapped.clear();
    }

    _reloadLayouts() {
        this._layouts = allLayouts(this._settings);
        this.emit('layouts-changed');
    }

    get layouts() {
        return this._layouts;
    }

    // --- Layout attivo per monitor -----------------------------------------

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

    // --- Geometria ---------------------------------------------------------

    workArea(monitor) {
        return Main.layoutManager.getWorkAreaForMonitor(monitor);
    }

    // Zone in pixel: `rect` è l'area della zona (per il puntatore), `target`
    // è il rettangolo in cui va la finestra (con lo spazio intorno)
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

    // Spazio di `half` tra zone vicine e di `2 * half` verso i bordi dello
    // schermo, così tutti gli spazi risultano uguali
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

    // Quarto dello schermo per lo snap negli angoli
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

    // --- Posizionamento ----------------------------------------------------

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
        // La dimensione originale è quella di prima del primo aggancio (la
        // posizione non conta: la finestra può essere appena stata trascinata)
        const sameSize = previous &&
            Math.abs(current.width - previous.target.width) <= 4 &&
            Math.abs(current.height - previous.target.height) <= 4;
        const orig = sameSize
            ? previous.orig
            : {width: current.width, height: current.height};

        if (window.get_maximize_flags())
            window.unmaximize();
        window.move_resize_frame(true, target.x, target.y, target.width, target.height);

        if (!previous)
            window.connectObject('unmanaged', () => this.forget(window), this);
        this._snapped.set(window, {
            monitor, zone, target: {...target}, orig, placedAt: GLib.get_monotonic_time(),
        });
        this.emit('window-placed', window);
    }

    forget(window) {
        if (!this._snapped.has(window))
            return;
        window.disconnectObject(this);
        this._snapped.delete(window);
    }

    // Stato di aggancio, valido solo se la finestra è ancora dove l'abbiamo
    // messa (se l'utente l'ha ridimensionata a mano non è più agganciata)
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

    // Ripristina la dimensione originale mantenendo il puntatore nella stessa
    // posizione relativa della finestra
    restoreSize(window, pointerX, pointerY) {
        const state = this._snapped.get(window);
        if (!state)
            return;
        this.forget(window);

        const rect = window.get_frame_rect();
        const relX = rect.width ? (pointerX - rect.x) / rect.width : 0.5;
        const relY = Math.min(pointerY - rect.y, state.orig.height / 2);
        const {width, height} = state.orig;
        const area = this.workArea(window.get_monitor());
        let x = Math.round(pointerX - relX * width);
        let y = Math.round(pointerY - Math.max(0, relY));
        x = Math.max(area.x - width + 50, Math.min(x, area.x + area.width - 50));
        y = Math.max(area.y, Math.min(y, area.y + area.height - 50));
        window.move_resize_frame(true, x, y, width, height);
    }

    // Zone del monitor occupate da finestre agganciate (sul workspace attivo)
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

    // Zona in cui si trova la finestra: quella agganciata o, altrimenti, quella
    // che si sovrappone di più
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

    // --- Azioni ------------------------------------------------------------

    moveInDirection(window, direction) {
        if (!isTileable(window))
            return;
        const monitor = window.get_monitor();
        const zones = this.zonesForMonitor(monitor);
        const state = this.snapState(window);
        const fromIndex = state && state.monitor === monitor ? state.zone : -1;

        // Finestra non agganciata: va nella zona più vicina a quel lato
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

        // Oltre il bordo: zona più vicina del monitor accanto
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

    // Zona adiacente nella direzione data: la più vicina tra quelle che stanno
    // da quel lato, preferendo quelle allineate sull'altro asse
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

    // Zona sul lato `direction` dell'area, la più allineata al rettangolo dato
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

    // Distribuisce le finestre del monitor nelle zone, dalla più recente
    applyToAll(monitor) {
        const zones = this.zonesForMonitor(monitor);
        const windows = this.windowsOnMonitor(monitor);
        windows.forEach((window, i) =>
            this.placeInZone(window, monitor, zones[i % zones.length].index));
    }

    // Finestre dello stesso monitor affiancate alla finestra data (lo spazio
    // tra le zone non conta)
    adjacentWindows(window) {
        if (!isTileable(window))
            return [];
        const rect = window.get_frame_rect();
        const tolerance = this._settings.get_int('zone-gap') + 12;
        return this.windowsOnMonitor(window.get_monitor())
            .filter(w => w !== window && areAdjacent(rect, w.get_frame_rect(), tolerance));
    }

    // Scambia posizione e dimensione di due finestre; chi era in una zona la
    // passa all'altra
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
