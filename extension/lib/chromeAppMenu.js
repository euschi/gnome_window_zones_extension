// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Menu della finestra sulla barra del titolo delle PWA di Chrome.
//
// La barra del titolo di una PWA è disegnata da Chrome: il clic destro apre un
// menu di Chrome (Indietro, Ricarica, Task Manager…) e non chiede mai a Mutter
// il menu della finestra, quindi le voci di windowMenu.js non compaiono.
//
// Su Wayland il clic arriva al client senza passare dalla Shell e non si può
// intercettare (i filtri di Clutter vengono dopo quello di Mutter). Si riconosce
// invece il popup appena nasce: quello del clic destro si apre sotto il puntatore
// che sta sulla barra, mentre gli altri (il pulsante ⋮, i tooltip) si aprono più
// in basso. Il popup resta nascosto, viene chiuso con un Esc e poi si apre il menu
// della finestra. Con Maiusc premuto resta il menu di Chrome.
//
// Attenzione: Meta.Window.delete() su un popup Wayland manda in crash Mutter.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isTileable} from './utils.js';

// Finestre delle PWA su Wayland: "chrome-<id app>-<profilo>". La finestra normale
// del browser ("google-chrome") ha il proprio menu e resta esclusa.
const CHROME_APP_CLASS = /^(chrome|chromium)-.+-(Default|Profile[ _]?\d+)$/;

// Altezza della barra del titolo di una PWA, in pixel logici. Chrome non la
// espone: se fosse più bassa del vero resterebbe il menu di Chrome in una
// striscia, se fosse più alta si perderebbe il menu della pagina.
const TITLE_BAR_HEIGHT = 28;

// Distanza verticale massima tra il puntatore e il bordo da cui si apre il popup.
// Deve restare piccola: il menu del pulsante ⋮ si apre pochi pixel sotto la barra.
const ANCHOR_TOLERANCE = 2;

// Oltre questo tempo si rinuncia e si rimette in vista il popup di Chrome
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

        // Il tasto destro non si può pretendere: con un clic rapido può essere
        // già stato rilasciato quando nasce il popup
        const [x, y, mods] = global.get_pointer();
        const ignored = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.BUTTON1_MASK;
        if ((mods & ignored) || !this._inTitleBar(parent, x, y))
            return;

        const actor = popup.get_compositor_private();
        if (!actor)
            return;

        this._finish(true);
        // Il popup non ha ancora una posizione: si nasconde subito per evitare
        // il lampo e si decide quando Chrome lo disegna
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

    // In orizzontale basta che il puntatore cada nel popup: vicino al bordo dello
    // schermo Chrome lo sposta. In basso, invece, lo apre verso l'alto.
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

        // Il menu prende un grab: meglio fuori dal segnale di Mutter
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
