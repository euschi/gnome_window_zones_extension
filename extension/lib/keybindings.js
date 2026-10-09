// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Keybindings {
    constructor(settings, zoneManager, actions) {
        this._settings = settings;
        this._names = [];
        const focused = () => global.display.focus_window;

        const bindings = {
            'move-zone-left': () => zoneManager.moveInDirection(focused(), 'left'),
            'move-zone-right': () => zoneManager.moveInDirection(focused(), 'right'),
            'move-zone-up': () => zoneManager.moveInDirection(focused(), 'up'),
            'move-zone-down': () => zoneManager.moveInDirection(focused(), 'down'),
            'show-layout-picker': () => actions.showLayoutPicker(),
            'apply-layout-all': () =>
                zoneManager.applyToAll(global.display.get_current_monitor()),
            'toggle-always-on-top': () => zoneManager.toggleAlwaysOnTop(focused()),
        };
        for (let n = 1; n <= 9; n++) {
            bindings[`move-to-zone-${n}`] = () => {
                const window = focused();
                if (window)
                    zoneManager.placeInZone(window, window.get_monitor(), n - 1);
            };
        }

        for (const [name, handler] of Object.entries(bindings)) {
            Main.wm.addKeybinding(name, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL, handler);
            this._names.push(name);
        }
    }

    destroy() {
        for (const name of this._names)
            Main.wm.removeKeybinding(name);
        this._names = [];
    }
}
