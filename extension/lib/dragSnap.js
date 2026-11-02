// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Trascinamento delle finestre:
// - con il tasto modificatore premuto compaiono le zone del layout e al
//   rilascio la finestra va nella zona sotto il puntatore;
// - senza tasto, portando il puntatore in alto compare la barra di tutti i
//   layout: al rilascio su una zona il layout si attiva e la finestra ci va;
// - senza tasto, portando il puntatore in un angolo la finestra va nel quarto
//   di schermo corrispondente;
// - una finestra agganciata che viene trascinata altrove torna alla sua
//   dimensione originale.
//
// Durante il grab di spostamento Mutter non passa gli eventi del puntatore
// alla Shell, quindi la posizione viene letta a intervalli regolari.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LayoutBar} from './layoutBar.js';
import {ZoneOverlay} from './zoneOverlay.js';
import {MODIFIER_MASKS, isPointerMove, isTileable} from './utils.js';

const POLL_INTERVAL_MS = 16;

// Striscia in cima all'area di lavoro che fa comparire la barra dei layout
const BAR_TRIGGER_HEIGHT = 16;

export class DragSnap {
    constructor(settings, zoneManager, onSnapped) {
        this._settings = settings;
        this._zones = zoneManager;
        this._onSnapped = onSnapped;
        this._overlay = new ZoneOverlay();
        this._bar = new LayoutBar(zoneManager);
        this._drag = null;
        this._pollId = 0;
        this._idleId = 0;

        global.display.connectObject(
            'grab-op-begin', (_d, window, op) => this._onGrabBegin(window, op),
            'grab-op-end', (_d, window) => this._onGrabEnd(window),
            this);
    }

    destroy() {
        global.display.disconnectObject(this);
        this._stopPolling();
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._setShellPreviewHidden(false);
        this._bar.destroy();
        this._overlay.destroy();
        this._drag = null;
    }

    _onGrabBegin(window, op) {
        if (!isPointerMove(op) || !isTileable(window))
            return;
        const rect = window.get_frame_rect();
        this._drag = {
            window,
            startX: rect.x,
            startY: rect.y,
            wasSnapped: !!this._zones.snapState(window),
            mode: null,
            monitor: -1,
            zone: null,
            quarter: null,
            barHit: null,
            previewKey: null,
            barArmed: false,
        };
        this._stopPolling();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
    }

    _poll() {
        const drag = this._drag;
        if (!drag)
            return;
        const [x, y, mods] = global.get_pointer();
        const monitor = global.display.get_current_monitor();
        const mask = MODIFIER_MASKS[this._settings.get_string('drag-modifier')] ?? 0;

        drag.mode = null;
        drag.monitor = monitor;

        if (this._settings.get_boolean('zones-drag-enabled') && (mods & mask)) {
            drag.mode = 'zone';
            drag.zone = this._zones.zoneAt(monitor, x, y);
            drag.previewKey = null;
            this._bar.hide();
            this._overlay.showZones(this._zones.zonesForMonitor(monitor),
                drag.zone?.index ?? -1);
        } else {
            this._pollBar(drag, monitor, x, y);
            if (!drag.mode && this._settings.get_boolean('corner-snap-enabled')) {
                const corner = this._cornerAt(monitor, x, y);
                if (corner) {
                    drag.mode = 'corner';
                    drag.previewKey = null;
                    drag.quarter = this._zones.quarterRect(monitor, corner);
                    this._overlay.showRect(drag.quarter);
                }
            }
        }

        if (!drag.mode) {
            drag.previewKey = null;
            this._overlay.hide();
        }
        this._setShellPreviewHidden(!!drag.mode);
    }

    _pollBar(drag, monitor, x, y) {
        if (!this._settings.get_boolean('drag-layout-bar-enabled')) {
            this._bar.hide();
            return;
        }

        const area = this._zones.workArea(monitor);
        const inStrip = y < area.y + BAR_TRIGGER_HEIGHT;
        // Una finestra già in alto parte con il puntatore nella striscia: la barra
        // non deve comparire a ogni presa, ma solo tornandoci
        if (!inStrip)
            drag.barArmed = true;

        const keepOpen = this._bar.monitor === monitor && this._bar.contains(x, y);
        const inCorner = this._settings.get_boolean('corner-snap-enabled') &&
            this._cornerAt(monitor, x, y);
        if (!keepOpen && !(drag.barArmed && inStrip && !inCorner)) {
            this._bar.hide();
            return;
        }

        this._bar.show(monitor);
        const hit = this._bar.update(x, y);
        if (!hit)
            return;

        const target = this._zones.zonesForLayout(hit.layout, monitor)[hit.index].target;
        drag.mode = 'layout';
        drag.barHit = {layout: hit.layout, index: hit.index};
        const key = `${hit.layout.id}/${hit.index}`;
        if (key !== drag.previewKey) {
            drag.previewKey = key;
            this._overlay.showRect(target);
        }
    }

    _cornerAt(monitor, x, y) {
        const area = this._zones.workArea(monitor);
        const size = this._settings.get_int('corner-size');
        const left = x < area.x + size;
        const right = x >= area.x + area.width - size;
        const top = y < area.y + size;
        const bottom = y >= area.y + area.height - size;
        if (top && left)
            return 'top-left';
        if (top && right)
            return 'top-right';
        if (bottom && left)
            return 'bottom-left';
        if (bottom && right)
            return 'bottom-right';
        return null;
    }

    // Nasconde l'anteprima dell'edge-tiling di GNOME mentre mostriamo la nostra
    _setShellPreviewHidden(hidden) {
        const preview = Main.wm._tilePreview;
        if (!preview)
            return;
        if (hidden) {
            preview.remove_all_transitions();
            preview.opacity = 0;
        } else if (preview._showing && preview.opacity === 0) {
            preview.opacity = 255;
        }
    }

    _onGrabEnd(window) {
        const drag = this._drag;
        if (!drag || drag.window !== window)
            return;
        this._poll();
        this._stopPolling();
        this._drag = null;
        this._bar.hide();
        this._overlay.hide();
        this._setShellPreviewHidden(false);

        // In idle: se GNOME ha appena agganciato la finestra a metà schermo o
        // l'ha massimizzata, la nostra sistemazione deve venire dopo
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            if (window.get_compositor_private())
                this._finish(window, drag);
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish(window, drag) {
        if (drag.mode === 'layout') {
            this._zones.setLayoutForMonitor(drag.monitor, drag.barHit.layout.id);
            this._zones.placeInZone(window, drag.monitor, drag.barHit.index);
            this._onSnapped(window, drag.monitor);
            return;
        }
        if (drag.mode === 'zone' && drag.zone) {
            this._zones.placeInZone(window, drag.monitor, drag.zone.index);
            this._onSnapped(window, drag.monitor);
            return;
        }
        if (drag.mode === 'corner') {
            this._zones.placeInRect(window, drag.quarter, {monitor: drag.monitor});
            this._onSnapped(window, drag.monitor);
            return;
        }

        // Trascinata via da una zona: dimensione originale (solo se è rimasta
        // della misura della zona, cioè GNOME non l'ha agganciata o massimizzata)
        if (!drag.wasSnapped || !this._settings.get_boolean('restore-size-on-drag'))
            return;
        const rect = window.get_frame_rect();
        const moved = Math.abs(rect.x - drag.startX) > 2 || Math.abs(rect.y - drag.startY) > 2;
        if (!moved)
            return;
        if (window.get_maximize_flags()) {
            this._zones.forget(window);
            return;
        }
        const [x, y] = global.get_pointer();
        this._zones.restoreSize(window, x, y);
    }
}
