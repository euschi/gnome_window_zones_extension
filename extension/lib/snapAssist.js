// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Snap Assist: dopo aver messo una finestra in una zona, mostra nelle zone
// ancora libere le miniature delle altre finestre; un clic la sistema lì e si
// passa alla zona libera successiva. Esc o un clic altrove chiudono.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isTileable} from './utils.js';

const THUMB_MAX_WIDTH = 220;
const THUMB_MAX_HEIGHT = 150;

export class SnapAssist {
    constructor(settings, zoneManager) {
        this._settings = settings;
        this._zones = zoneManager;
        this._actor = null;
        this._grab = null;
    }

    destroy() {
        this.close();
    }

    show(placedWindow, monitor) {
        this.close();
        if (!this._settings.get_boolean('snap-assist-enabled'))
            return;
        this._monitor = monitor;
        this._exclude = new Set([placedWindow]);
        if (!this._freeZone() || this._candidates().length === 0)
            return;
        this._open();
    }

    // Prima zona del monitor non occupata da una finestra agganciata
    _freeZone() {
        const occupied = this._zones.occupiedZones(this._monitor);
        return this._zones.zonesForMonitor(this._monitor)
            .find(z => !occupied.has(z.index)) ?? null;
    }

    // Finestre del workspace attivo che non sono già in una zona del monitor
    _candidates() {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace).filter(w => {
            if (!isTileable(w) || this._exclude.has(w) || !w.get_compositor_private())
                return false;
            const state = this._zones.snapState(w);
            return !state || state.monitor !== this._monitor || state.zone < 0;
        });
    }

    _open() {
        const monitor = Main.layoutManager.monitors[this._monitor];
        this._actor = new St.Widget({
            style_class: 'winzones-assist',
            reactive: true,
            x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height,
        });
        Main.layoutManager.uiGroup.add_child(this._actor);

        this._actor.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._actor.connect('button-release-event', (_a, event) => {
            if (global.stage.get_event_actor(event) === this._actor)
                this.close();
            return Clutter.EVENT_STOP;
        });
        global.display.connectObject('window-created', () => this.close(), this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this.close(), this);

        // Il grab modale solo a interfaccia pronta: un errore non deve lasciare
        // lo schermo bloccato
        try {
            this._showNextZone();
        } catch (e) {
            this.close();
            throw e;
        }
        if (!this._actor)
            return;
        this._grab = Main.pushModal(this._actor);
        global.stage.set_key_focus(this._actor);
    }

    _showNextZone() {
        const zone = this._freeZone();
        const candidates = this._candidates();
        if (!zone || candidates.length === 0) {
            this.close();
            return;
        }

        this._actor.destroy_all_children();
        const monitor = Main.layoutManager.monitors[this._monitor];
        const panel = new St.BoxLayout({
            style_class: 'winzones-assist-zone',
            orientation: Clutter.Orientation.VERTICAL,
            x: zone.rect.x - monitor.x, y: zone.rect.y - monitor.y,
            width: zone.rect.width, height: zone.rect.height,
            reactive: true,
        });
        panel.add_child(new St.Label({
            style_class: 'winzones-assist-title',
            text: _('Choose a window for this zone'),
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const flow = new St.Viewport({
            layout_manager: new Clutter.FlowLayout({
                column_spacing: 12, row_spacing: 12, homogeneous: false,
            }),
            x_expand: true,
        });
        const scroll = new St.ScrollView({
            x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            child: flow,
        });
        panel.add_child(scroll);

        for (const window of candidates)
            flow.add_child(this._thumbnail(window, zone));

        this._actor.add_child(panel);
    }

    _thumbnail(window, zone) {
        const source = window.get_compositor_private();
        const [w, h] = source.get_size();
        const scale = Math.min(THUMB_MAX_WIDTH / w, THUMB_MAX_HEIGHT / h, 1);

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        box.add_child(new Clutter.Clone({
            source,
            width: Math.round(w * scale),
            height: Math.round(h * scale),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            style_class: 'winzones-assist-label',
            text: window.get_title() ?? '',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const button = new St.Button({
            style_class: 'winzones-assist-window',
            child: box,
            can_focus: true,
        });
        button.connect('clicked', () => {
            if (!window.get_compositor_private())
                return;
            this._zones.placeInZone(window, this._monitor, zone.index);
            window.activate(global.get_current_time());
            this._exclude.add(window);
            this._showNextZone();
        });
        return button;
    }

    close() {
        if (!this._actor)
            return;
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._actor.destroy();
        this._actor = null;
    }
}
