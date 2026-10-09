// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Selettore dei layout (stile Snap Layouts di Windows 11): mostra le
// miniature di tutti i layout sul monitor corrente. Un clic su una zona rende
// attivo quel layout per il monitor e ci sposta la finestra attiva; un clic sul
// nome attiva solo il layout.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {zonesFromTree} from './layoutModel.js';
import {isTileable} from './utils.js';

const THUMB_WIDTH = 176;

export class LayoutPicker {
    constructor(zoneManager, onSnapped) {
        this._zones = zoneManager;
        this._onSnapped = onSnapped;
        this._actor = null;
        this._grab = null;
    }

    destroy() {
        this.close();
    }

    toggle() {
        if (this._actor)
            this.close();
        else
            this.open();
    }

    open() {
        this.close();
        const window = global.display.focus_window;
        this._window = isTileable(window) ? window : null;
        this._monitorIndex = this._window
            ? this._window.get_monitor() : global.display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!monitor)
            return;

        this._actor = new St.Widget({
            style_class: 'winzones-picker-backdrop',
            reactive: true,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
            layout_manager: new Clutter.BinLayout(),
        });
        Main.layoutManager.uiGroup.add_child(this._actor);

        const panel = new St.BoxLayout({
            style_class: 'winzones-picker',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        panel.add_child(new St.Label({
            style_class: 'winzones-picker-title',
            text: this._window
                ? _('Choose a zone for “%s”').format(this._window.get_title() ?? '')
                : _('Choose the layout of this monitor'),
        }));

        const columns = Math.max(1, Math.min(5,
            Math.floor((monitor.width * 0.8) / (THUMB_WIDTH + 24))));
        const grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({column_spacing: 18, row_spacing: 18}),
        });
        const gridLayout = grid.layout_manager;
        const active = this._zones.layoutForMonitor(this._monitorIndex);
        this._zones.layouts.forEach((layout, i) => {
            gridLayout.attach(this._layoutThumb(layout, monitor, layout.id === active.id),
                i % columns, Math.floor(i / columns), 1, 1);
        });
        panel.add_child(grid);
        this._actor.add_child(panel);

        this._grab = Main.pushModal(this._actor);
        global.stage.set_key_focus(this._actor);
        this._actor.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._actor.connect('button-release-event', (_a, event) => {
            if (global.stage.get_event_actor(event) === this._actor)
                this.close();
            return Clutter.EVENT_STOP;
        });
    }

    _layoutThumb(layout, monitor, isActive) {
        const width = THUMB_WIDTH;
        const height = Math.round(width * monitor.height / monitor.width);
        const box = new St.BoxLayout({
            style_class: 'winzones-picker-layout',
            orientation: Clutter.Orientation.VERTICAL,
        });
        if (isActive)
            box.add_style_pseudo_class('checked');

        const canvas = new St.Widget({width, height});
        const gap = 3;
        for (const [index, f] of zonesFromTree(layout.root).entries()) {
            const zone = new St.Button({
                style_class: 'winzones-picker-zone',
                x: Math.round(f.x * width + gap / 2),
                y: Math.round(f.y * height + gap / 2),
                width: Math.max(1, Math.round(f.w * width - gap)),
                height: Math.max(1, Math.round(f.h * height - gap)),
                can_focus: true,
                reactive: !!this._window,
            });
            zone.connect('clicked', () => this._choose(layout, index));
            canvas.add_child(zone);
        }
        box.add_child(canvas);

        const name = new St.Button({
            style_class: 'winzones-picker-name',
            label: _(layout.name) || _('Untitled'),
            can_focus: true,
        });
        name.connect('clicked', () => this._choose(layout, -1));
        box.add_child(name);
        return box;
    }

    _choose(layout, zoneIndex) {
        const window = this._window;
        const monitor = this._monitorIndex;
        this.close();
        this._zones.setLayoutForMonitor(monitor, layout.id);
        if (window && zoneIndex >= 0 && window.get_compositor_private()) {
            this._zones.placeInZone(window, monitor, zoneIndex);
            window.activate(global.get_current_time());
            this._onSnapped(window, monitor);
        }
    }

    close() {
        if (!this._actor)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._actor.destroy();
        this._actor = null;
        this._window = null;
    }
}
