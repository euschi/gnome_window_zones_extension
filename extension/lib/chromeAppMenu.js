// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Window menu on the title bar of Chrome PWAs.
//
// The title bar of a PWA is drawn by Chrome: right click opens a Chrome menu
// (Back, Reload, Task Manager…) and never asks Mutter for the window menu, so
// the items from windowMenu.js don't show up.
//
// On Wayland the click reaches the client without going through the Shell and
// can't be intercepted (Clutter filters run after Mutter's). The popup is
// recognized as soon as it appears instead: the right click one opens under the
// pointer, which is on the title bar, while the others (the ⋮ button, tooltips)
// open lower down. The popup stays hidden, is closed with an Esc and then the
// window menu opens. With Shift held down the Chrome menu stays.
//
// Warning: Meta.Window.delete() on a Wayland popup crashes Mutter.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isTileable} from './utils.js';

// PWA windows on Wayland: "chrome-<app id>-<profile>". The regular browser
// window ("google-chrome") has its own menu and stays excluded.
const CHROME_APP_CLASS = /^(chrome|chromium)-.+-(Default|Profile[ _]?\d+)$/;

// Height of a PWA title bar, in logical pixels. Chrome doesn't expose it: if
// lower than the real one, the Chrome menu would remain in a strip, if higher,
// the page menu would be lost.
const TITLE_BAR_HEIGHT = 28;

// Maximum vertical distance between the pointer and the edge the popup opens
// from. It must stay small: the ⋮ button menu opens a few pixels below the bar.
const ANCHOR_TOLERANCE = 2;

// After this time, give up and show the Chrome popup again
const POPUP_TIMEOUT_MS = 500;

export class ChromeAppMenu {
    constructor(settings) {
        this._settings = settings;
        this._pending = null;
        this._keyboard = null;
        this._idleId = 0;

        global.display.connectObject('window-created',
            (_display, window) => this._onWindowCreated(window), this);
    }

    destroy() {
        global.display.disconnectObject(this);
        this._finish(true);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }

    _onWindowCreated(popup) {
        if (popup.get_window_type() !== Meta.WindowType.DROPDOWN_MENU)
            return;
        if (!this._settings.get_boolean('window-menu-enabled'))
            return;

        const parent = popup.get_transient_for();
        if (!CHROME_APP_CLASS.test(parent?.get_wm_class() ?? '') || !isTileable(parent))
            return;

        // The right button can't be required: with a quick click it may already
        // be released when the popup appears
        const [x, y, mods] = global.get_pointer();
        const ignored = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.BUTTON1_MASK;
        if ((mods & ignored) || !this._inTitleBar(parent, x, y))
            return;

        const actor = popup.get_compositor_private();
        if (!actor)
            return;

        this._finish(true);
        // The popup has no position yet: hide it right away to avoid a flash,
        // and decide when Chrome draws it
        actor.opacity = 0;
        this._pending = {popup, parent, actor, x, y, dismissing: false};
        popup.connectObject(
            'size-changed', () => this._onPopupPlaced(),
            'position-changed', () => this._onPopupPlaced(),
            'unmanaged', () => this._onPopupGone(),
            this);
        this._pending.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPUP_TIMEOUT_MS, () => {
            this._pending.timeoutId = 0;
            this._finish(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _inTitleBar(window, x, y) {
        const frame = window.get_frame_rect();
        return x >= frame.x && x < frame.x + frame.width &&
            y >= frame.y && y < frame.y + TITLE_BAR_HEIGHT;
    }

    _onPopupPlaced() {
        const pending = this._pending;
        if (!pending || pending.dismissing)
            return;

        const rect = pending.popup.get_frame_rect();
        if (rect.width === 0 || rect.height === 0)
            return;

        if (!this._isAnchoredAtPointer(rect, pending)) {
            this._finish(true);
            return;
        }
        pending.dismissing = true;
        this._pressEscape();
    }

    // Horizontally the pointer just has to fall inside the popup: near the
    // screen edge Chrome moves it. At the bottom, though, it opens upwards.
    _isAnchoredAtPointer(rect, {x, y}) {
        const closeTo = (a, b) => Math.abs(a - b) <= ANCHOR_TOLERANCE;
        return x >= rect.x && x <= rect.x + rect.width &&
            (closeTo(rect.y, y) || closeTo(rect.y + rect.height, y));
    }

    _pressEscape() {
        if (!this._keyboard) {
            const seat = global.stage.context.get_backend().get_default_seat();
            this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(time, Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
    }

    _onPopupGone() {
        const pending = this._pending;
        if (!pending)
            return;
        const {parent, x, y, dismissing} = pending;
        this._finish(false);
        if (!dismissing)
            return;

        // The menu takes a grab: better outside of the Mutter signal
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            if (parent.get_compositor_private()) {
                Main.wm._windowMenuManager.showWindowMenuForWindow(parent,
                    Meta.WindowMenuType.WM, {x, y, width: 0, height: 0});
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish(restore) {
        const pending = this._pending;
        if (!pending)
            return;
        this._pending = null;
        if (pending.timeoutId)
            GLib.source_remove(pending.timeoutId);
        pending.popup.disconnectObject(this);
        if (restore)
            pending.actor.opacity = 255;
    }
}
