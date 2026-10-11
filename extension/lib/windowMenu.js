// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Voci aggiunte al menu della finestra (clic destro sulla barra del titolo):
// miniatura del layout attivo per mettere la finestra in una zona, sottomenu
// con tutti i layout (un clic su una zona cambia layout e sposta la finestra,
// un clic sul nome cambia solo il layout) e scambio di posizione con le
// finestre affiancate.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {WindowMenu} from 'resource:///org/gnome/shell/ui/windowMenu.js';
import {
    InjectionManager, gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {zonesFromTree} from './layoutModel.js';
import {isTileable} from './utils.js';

const THUMB_WIDTH = 168;
const SMALL_THUMB_WIDTH = 60;
const MAX_TITLE_LENGTH = 40;

export class WindowMenuItems {
    constructor(settings, zoneManager, onSnapped) {
        this._settings = settings;
        this._zones = zoneManager;
        this._onSnapped = onSnapped;
        this._injections = new InjectionManager();

        const self = this;
        this._injections.overrideMethod(WindowMenu.prototype, '_buildMenu',
            original => function (window) {
                original.call(this, window);
                if (!self._settings.get_boolean('window-menu-enabled'))
                    return;
                // Un errore qui non deve togliere il menu della finestra
                try {
                    self._addItems(this, window);
                } catch (e) {
                    logError(e, 'Window Zones: window menu');
                }
            });
    }

    destroy() {
        this._injections.clear();
    }

    _addItems(menu, window) {
        const monitor = window.get_monitor();
        const geometry = Main.layoutManager.monitors[monitor];
        if (!isTileable(window) || !geometry)
            return;

        // Il sottomenu dei layout può essere lungo: limitando l'altezza del
        // menu all'area di lavoro, il sottomenu scorre invece di uscire dallo
        // schermo
        const workArea = this._zones.workArea(monitor);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        menu.actor.style = `max-height: ${Math.round(workArea.height / scale)}px;`;

        // Prima dell'ultimo separatore e di "Chiudi"
        let position = Math.max(0, menu.numMenuItems - 2);
        const add = item => menu.addMenuItem(item, position++);

        const active = this._zones.layoutForMonitor(monitor);
        const state = this._zones.snapState(window);
        const currentZone = state && state.monitor === monitor ? state.zone : -1;
        let layoutsItem = null;
        const place = (layout, zoneIndex) => {
            // Il menu della finestra viene distrutto appena si chiude, mentre
            // il sottomenu si chiuderebbe solo a fine animazione, su un menu
            // ormai distrutto: va chiuso prima e senza animazione
            layoutsItem?.menu.close({animate: false});
            menu.close();
            this._zones.setLayoutForMonitor(monitor, layout.id);
            if (zoneIndex < 0 || !window.get_compositor_private())
                return;
            this._zones.placeInZone(window, monitor, zoneIndex);
            window.activate(global.get_current_time());
            this._onSnapped(window, monitor);
        };

        add(new PopupMenu.PopupSeparatorMenuItem());

        // Zone del layout attivo
        const zonesItem = this._containerItem();
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'winzones-menu-box',
            x_expand: true,
        });
        box.add_child(new St.Label({
            text: _('Move to Zone'),
            style_class: 'winzones-menu-heading',
        }));
        box.add_child(this._thumbnail(active, geometry, THUMB_WIDTH, true,
            currentZone, index => place(active, index)));
        zonesItem.add_child(box);
        // Stesso rientro delle voci native del menu
        zonesItem.setOrnament(PopupMenu.Ornament.NONE);
        add(zonesItem);

        // Tutti i layout
        layoutsItem = new PopupMenu.PopupSubMenuMenuItem(
            _('Layout: %s').format(_(active.name) || _('Untitled')));
        layoutsItem.setOrnament(PopupMenu.Ornament.NONE);
        for (const layout of this._zones.layouts) {
            const isActive = layout.id === active.id;
            const row = this._containerItem('winzones-menu-layout-item');
            const rowBox = new St.BoxLayout({style_class: 'winzones-menu-layout', x_expand: true});
            if (isActive)
                rowBox.add_style_pseudo_class('checked');
            rowBox.add_child(this._thumbnail(layout, geometry, SMALL_THUMB_WIDTH, false,
                isActive ? currentZone : -1, index => place(layout, index)));
            const name = new St.Button({
                style_class: 'winzones-menu-layout-name',
                label: _(layout.name) || _('Untitled'),
                can_focus: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.START,
            });
            name.connect('clicked', () => place(layout, -1));
            rowBox.add_child(name);
            row.add_child(rowBox);
            layoutsItem.menu.addMenuItem(row);
        }
        add(layoutsItem);

        // Scambio con le finestre affiancate
        for (const other of this._zones.adjacentWindows(window)) {
            let title = other.get_title() ?? '';
            if (title.length > MAX_TITLE_LENGTH)
                title = `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
            const item = new PopupMenu.PopupMenuItem(_('Swap with “%s”').format(title));
            item.setOrnament(PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                if (window.get_compositor_private() && other.get_compositor_private())
                    this._zones.swapWindows(window, other);
            });
            add(item);
        }
    }

    // Voce che fa solo da contenitore per dei pulsanti: non si attiva e non si
    // evidenzia, ma resta reattiva (St segna come "insensitive", e quindi
    // attenua, i widget non reattivi)
    _containerItem(styleClass = null) {
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false, hover: false, can_focus: false, style_class: styleClass,
        });
        item.track_hover = false;
        item.remove_style_class_name('popup-inactive-menu-item');
        return item;
    }

    // Miniatura del layout in proporzione al monitor; ogni zona è un pulsante
    _thumbnail(layout, geometry, width, numbered, checkedZone, onZone) {
        const height = Math.round(width * geometry.height / geometry.width);
        const canvas = new St.Widget({width, height, style_class: 'winzones-menu-thumb'});
        const gap = 3;
        for (const [index, f] of zonesFromTree(layout.root).entries()) {
            const zone = new St.Button({
                style_class: 'winzones-menu-zone',
                label: numbered ? String(index + 1) : '',
                x: Math.round(f.x * width + gap / 2),
                y: Math.round(f.y * height + gap / 2),
                width: Math.max(1, Math.round(f.w * width - gap)),
                height: Math.max(1, Math.round(f.h * height - gap)),
                can_focus: true,
            });
            if (index === checkedZone)
                zone.add_style_pseudo_class('checked');
            zone.connect('clicked', () => onZone(index));
            canvas.add_child(zone);
        }
        return canvas;
    }
}
