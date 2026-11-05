// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Items added to the window menu (right click on the title bar): thumbnail of
// the active layout to put the window in a zone, submenu with all the layouts
// (a click on a zone changes the layout and moves the window, a click on the
// name only changes the layout) and position swap with the windows side by side.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {WindowMenu} from 'resource:///org/gnome/shell/ui/windowMenu.js';
import {
    InjectionManager, gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {thumbnailRects} from './layoutModel.js';
import {isTileable} from './utils.js';

const THUMB_WIDTH = 168;
const SMALL_THUMB_WIDTH = 60;
const ZONE_GAP = 3;
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
                if (self._settings.get_boolean('window-menu-enabled'))
                    self._addItems(this, window);
            });
    }

    destroy() {
        this._injections.clear();
    }

    _addItems(menu, window) {
        if (!isTileable(window))
            return;
        const monitor = window.get_monitor();
        const geometry = Main.layoutManager.monitors[monitor];

        // The layout submenu can be long: by limiting the menu height to the work
        // area, the submenu scrolls instead of going off screen
        const workArea = this._zones.workArea(monitor);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        menu.actor.style = `max-height: ${Math.round(workArea.height / scale)}px;`;

        // Before the last separator and "Close"
        let position = Math.max(0, menu.numMenuItems - 2);
        const add = item => menu.addMenuItem(item, position++);

        const active = this._zones.layoutForMonitor(monitor);
        const state = this._zones.snapState(window);
        const currentZone = state && state.monitor === monitor ? state.zone : -1;
        let layoutsItem = null;
        const place = (layout, zoneIndex) => {
            // The window menu is destroyed as soon as it closes, while the submenu
            // would only close at the end of its animation, on a menu already
            // destroyed: it has to be closed first and without animation
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
        // Same indentation as the native menu items
        zonesItem.setOrnament(PopupMenu.Ornament.NONE);
        add(zonesItem);

        layoutsItem = new PopupMenu.PopupSubMenuMenuItem(
            _('Layout: %s').format(_(active.name)));
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
                label: _(layout.name),
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

    // Item acting only as a container for buttons: it doesn't activate or
    // highlight, but stays reactive (St marks non-reactive widgets as
    // "insensitive", which dims them)
    _containerItem(styleClass = null) {
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false, hover: false, can_focus: false, style_class: styleClass,
        });
        item.track_hover = false;
        item.remove_style_class_name('popup-inactive-menu-item');
        return item;
    }

    // Layout thumbnail proportional to the monitor; each zone is a button
    _thumbnail(layout, geometry, width, numbered, checkedZone, onZone) {
        const height = Math.round(width * geometry.height / geometry.width);
        const canvas = new St.Widget({width, height});
        for (const [index, rect] of thumbnailRects(layout.root, width, height, ZONE_GAP).entries()) {
            const zone = new St.Button({
                style_class: 'winzones-menu-zone',
                label: numbered ? String(index + 1) : '',
                ...rect,
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
