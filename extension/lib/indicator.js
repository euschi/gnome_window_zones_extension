// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Indicatore nel pannello: layout attivo di ogni monitor e azioni rapide.

import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {monitorConnectors} from './utils.js';

export const WinZonesIndicator = GObject.registerClass(
class WinZonesIndicator extends PanelMenu.Button {
    _init(extension, zoneManager, actions) {
        super._init(0.0, _('Window Zones'));
        this._extension = extension;
        this._zones = zoneManager;
        this._actions = actions;

        this.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic',
            style_class: 'system-status-icon',
        }));

        // Il menu viene ricostruito all'apertura: layout e monitor possono
        // essere cambiati nel frattempo
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._buildMenu();
        });
        this._buildMenu();
    }

    _buildMenu() {
        const menu = this.menu;
        menu.removeAll();

        const connectors = monitorConnectors();
        const monitors = Main.layoutManager.monitors;
        for (const monitor of monitors) {
            const active = this._zones.layoutForMonitor(monitor.index);
            const title = monitors.length > 1
                ? _('Layout — %s').format(connectors.get(monitor.index) ?? monitor.index + 1)
                : _('Layout');
            const sub = new PopupMenu.PopupSubMenuMenuItem(
                `${title}: ${_(active.name) || _('Untitled')}`);
            for (const layout of this._zones.layouts) {
                const item = sub.menu.addAction(_(layout.name) || _('Untitled'), () =>
                    this._zones.setLayoutForMonitor(monitor.index, layout.id));
                item.setOrnament(layout.id === active.id
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
            menu.addMenuItem(sub);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Choose Layout and Zone…'), () => this._actions.showLayoutPicker());
        menu.addAction(_('Arrange Windows in Zones'), () => {
            for (const monitor of monitors)
                this._zones.applyToAll(monitor.index);
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Settings'), () => this._extension.openPreferences());
    }
});
