// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Double click on a resize border → maximize in one direction only, like on
// Windows (top/bottom: vertically, left/right: horizontally).
//
// On Wayland the borders of client-side decorated windows belong to the client,
// so the Shell doesn't receive the clicks. However, each press on the border
// starts a Mutter resize grab: two grabs on the same side of the same window,
// close in time and with no size change, are a double click. The action happens
// at the end of the second grab, so there is no grab to cancel.
//
// Once maximized in one direction the window no longer has a clickable border
// on that side (it ends up under the panel or off screen) and Mutter locks it on
// that axis: when dragged along the locked axis, on release it returns to its
// previous size, under the pointer.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {GrabOpBits, frameRectEquals, isPointerMove} from './utils.js';

// Minimum pointer movement along the locked axis to restore the size
const UNMAXIMIZE_DRAG_DISTANCE = 40;

export class EdgeDoubleClick {
    constructor(settings) {
        this._settings = settings;
        this._press = null;     // resize grab in progress
        this._lastClick = null; // last "click" (grab with no resize)
        this._idleId = 0;
        this._move = null;      // move of a half-maximized window
        this._saved = new Map(); // window → size before the maximization
        this._mouseSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'});

        global.display.connectObject(
            'grab-op-begin', (_d, window, op) => this._onGrabBegin(window, op),
            'grab-op-end', (_d, window) => this._onGrabEnd(window),
            this);
    }

    destroy() {
        global.display.disconnectObject(this);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._press = null;
        this._lastClick = null;
        this._move = null;
        for (const window of this._saved.keys())
            window.disconnectObject(this);
        this._saved.clear();
        this._mouseSettings = null;
    }

    _edgeOf(op) {
        if (op & GrabOpBits.KEYBOARD)
            return null;
        switch (op & GrabOpBits.EDGES) {
        case GrabOpBits.NORTH:
        case GrabOpBits.SOUTH:
            return 'vertical';
        case GrabOpBits.EAST:
        case GrabOpBits.WEST:
            return 'horizontal';
        default:
            return null; // corners or move
        }
    }

    _onGrabBegin(window, op) {
        this._move = null;
        if (window && isPointerMove(op) && this._singleAxis(window)) {
            const [x, y] = global.get_pointer();
            this._move = {window, x, y, rect: window.get_frame_rect()};
        }

        const edge = this._edgeOf(op);
        if (!window || !edge || !this._settings.get_boolean('edge-dblclick-enabled')) {
            this._press = null;
            return;
        }
        this._press = {
            window, edge,
            side: op & GrabOpBits.EDGES,
            rect: window.get_frame_rect(),
            time: GLib.get_monotonic_time(),
        };
    }

    _singleAxis(window) {
        const flags = window.get_maximize_flags();
        return flags === Meta.MaximizeFlags.VERTICAL || flags === Meta.MaximizeFlags.HORIZONTAL;
    }

    _onGrabEnd(window) {
        const move = this._move;
        this._move = null;
        if (move && move.window === window)
            this._maybeRestoreAfterMove(move);

        const press = this._press;
        this._press = null;
        if (!press || press.window !== window)
            return;

        // An actual resize is not a click
        if (!frameRectEquals(window.get_frame_rect(), press.rect, 2)) {
            this._lastClick = null;
            return;
        }

        const last = this._lastClick;
        const maxDelay = this._mouseSettings.get_int('double-click') * 1000;
        if (last && last.window === window && last.side === press.side &&
            press.time - last.time <= maxDelay) {
            this._lastClick = null;
            this._schedule(window, press.edge);
        } else {
            this._lastClick = press;
        }
    }

    _schedule(window, edge) {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._toggle(window, edge);
            return GLib.SOURCE_REMOVE;
        });
    }

    _toggle(window, edge) {
        if (edge === 'horizontal' && !this._settings.get_boolean('edge-dblclick-horizontal'))
            return;
        if (!window.get_compositor_private() || !window.can_maximize())
            return;

        const flag = edge === 'vertical'
            ? Meta.MaximizeFlags.VERTICAL : Meta.MaximizeFlags.HORIZONTAL;
        if (window.get_maximize_flags() & flag) {
            window.unmaximize();
            this._forget(window);
            return;
        }
        if (!window.get_maximize_flags()) {
            const {width, height} = window.get_frame_rect();
            if (!this._saved.has(window))
                window.connectObject('unmanaged', () => this._forget(window), this);
            this._saved.set(window, {width, height});
        }
        window.set_maximize_flags(flag);
    }

    _forget(window) {
        if (this._saved.delete(window))
            window.disconnectObject(this);
    }

    _maybeRestoreAfterMove(move) {
        const {window} = move;
        const flags = window.get_maximize_flags();
        if (!this._singleAxis(window))
            return;
        const vertical = flags === Meta.MaximizeFlags.VERTICAL;
        const [x, y] = global.get_pointer();
        const distance = vertical ? y - move.y : x - move.x;
        if (Math.abs(distance) < UNMAXIMIZE_DRAG_DISTANCE)
            return;

        const current = window.get_frame_rect();
        const saved = this._saved.get(window) ?? {
            width: vertical ? current.width : Math.round(current.width * 2 / 3),
            height: vertical ? Math.round(current.height * 2 / 3) : current.height,
        };
        this._forget(window);

        // The pointer keeps the same distance from the top edge (title bar) and
        // the same relative position horizontally
        const relX = (move.x - move.rect.x) / move.rect.width;
        const area = window.get_work_area_current_monitor();
        const newX = vertical ? current.x : Math.max(area.x, Math.min(
            Math.round(x - relX * saved.width), area.x + area.width - saved.width));
        const newY = vertical
            ? Math.round(y - Math.min(move.y - move.rect.y, saved.height / 2))
            : current.y;
        window.unmaximize();
        window.move_resize_frame(true, newX, newY, saved.width, saved.height);
    }
}
