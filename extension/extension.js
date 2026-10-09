// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DragSnap} from './lib/dragSnap.js';
import {EdgeDoubleClick} from './lib/edgeDoubleClick.js';
import {WinZonesIndicator} from './lib/indicator.js';
import {Keybindings} from './lib/keybindings.js';
import {LayoutPicker} from './lib/layoutPicker.js';
import {SnapAssist} from './lib/snapAssist.js';
import {ZoneManager} from './lib/zoneManager.js';

export default class WinZonesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._zones = new ZoneManager(this._settings);
        this._snapAssist = new SnapAssist(this._settings, this._zones);
        const onSnapped = (window, monitor) => this._snapAssist.show(window, monitor);

        this._picker = new LayoutPicker(this._zones, onSnapped);
        this._actions = {showLayoutPicker: () => this._picker.toggle()};

        this._edgeDoubleClick = new EdgeDoubleClick(this._settings);
        this._dragSnap = new DragSnap(this._settings, this._zones, onSnapped);
        this._keybindings = new Keybindings(this._settings, this._zones, this._actions);

        this._settings.connectObject('changed::show-indicator',
            () => this._syncIndicator(), this);
        this._syncIndicator();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;
        this._keybindings.destroy();
        this._dragSnap.destroy();
        this._edgeDoubleClick.destroy();
        this._picker.destroy();
        this._snapAssist.destroy();
        this._zones.destroy();
        this._keybindings = this._dragSnap = this._edgeDoubleClick = null;
        this._picker = this._snapAssist = this._zones = this._actions = null;
        this._settings = null;
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new WinZonesIndicator(this, this._zones, this._actions);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
