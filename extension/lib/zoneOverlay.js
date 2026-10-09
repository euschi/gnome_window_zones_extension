// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Disegna sopra le finestre le zone del layout (con quella sotto il puntatore
// evidenziata) oppure un singolo rettangolo di anteprima.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class ZoneOverlay {
    constructor() {
        this._actor = new St.Widget({visible: false, x: 0, y: 0});
        Main.layoutManager.uiGroup.insert_child_above(this._actor, global.window_group);
        this._key = null;
        this._zoneActors = [];
    }

    destroy() {
        this._actor.destroy();
        this._actor = null;
        this._zoneActors = [];
    }

    // zones: [{index, rect}], active: indice evidenziato (o -1)
    showZones(zones, active) {
        const key = JSON.stringify(zones.map(z => z.rect));
        if (key !== this._key) {
            this._key = key;
            this._actor.destroy_all_children();
            this._zoneActors = zones.map(zone => {
                const actor = new St.Bin({
                    style_class: 'winzones-zone',
                    x: zone.rect.x, y: zone.rect.y,
                    width: zone.rect.width, height: zone.rect.height,
                    child: new St.Label({
                        style_class: 'winzones-zone-label',
                        text: String(zone.index + 1),
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                });
                this._actor.add_child(actor);
                return actor;
            });
        }
        this._zoneActors.forEach((actor, i) => {
            if (i === active)
                actor.add_style_pseudo_class('active');
            else
                actor.remove_style_pseudo_class('active');
        });
        this._actor.show();
    }

    showRect(rect) {
        this._key = null;
        this._actor.destroy_all_children();
        this._zoneActors = [];
        const actor = new St.Widget({
            style_class: 'winzones-zone',
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        });
        actor.add_style_pseudo_class('active');
        this._actor.add_child(actor);
        this._actor.show();
    }

    hide() {
        this._actor.hide();
    }

    get visible() {
        return this._actor.visible;
    }
}
