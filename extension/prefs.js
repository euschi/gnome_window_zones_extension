// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    BUILTIN_LAYOUTS, allLayouts, cloneNode, newLayoutId, parseCustomLayouts,
    parseJsonObject, serializeCustomLayouts,
} from './lib/layoutModel.js';
import {openLayoutEditor} from './prefs/layoutEditor.js';
import {createPreview} from './prefs/layoutPreview.js';
import {ShortcutRow} from './prefs/shortcutRow.js';

export default class WinZonesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(680, 760);
        window.set_search_enabled(true);

        const MODIFIERS = [['shift', _('Shift')], ['ctrl', _('Ctrl')],
            ['alt', _('Alt')], ['super', _('Super')]];

        const switchRow = (key, title, subtitle = null) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const spinRow = (key, title, min, max, step = 1, subtitle = null) => {
            const row = new Adw.SpinRow({
                title, subtitle,
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const comboRow = (key, title, options, subtitle = null) => {
            const row = new Adw.ComboRow({
                title, subtitle,
                model: Gtk.StringList.new(options.map(o => o[1])),
            });
            const sync = () => {
                const i = options.findIndex(o => o[0] === settings.get_string(key));
                if (i >= 0 && row.selected !== i)
                    row.selected = i;
            };
            sync();
            row.connect('notify::selected', () => {
                const value = options[row.selected]?.[0];
                if (value && value !== settings.get_string(key))
                    settings.set_string(key, value);
            });
            settings.connect(`changed::${key}`, sync);
            return row;
        };

        const group = (title, rows, description = null) => {
            const g = new Adw.PreferencesGroup({title, description});
            rows.forEach(r => g.add(r));
            return g;
        };

        const page = (title, icon, groups) => {
            const p = new Adw.PreferencesPage({title, icon_name: icon});
            groups.forEach(g => p.add(g));
            window.add(p);
            return p;
        };

        // --- Generale ------------------------------------------------------

        const horizontal = switchRow('edge-dblclick-horizontal',
            _('Left and Right Borders'), _('Maximize horizontally'));
        settings.bind('edge-dblclick-enabled', horizontal, 'sensitive',
            Gio.SettingsBindFlags.GET);

        page(_('General'), 'preferences-system-symbolic', [
            group(_('Double Click on the Border'), [
                switchRow('edge-dblclick-enabled', _('Top and Bottom Borders'),
                    _('Maximize vertically only, like on Windows')),
                horizontal,
            ], _('Double click where the resize cursor appears. Drag the window along the maximized direction to restore it.')),
            group(_('Zones'), [
                switchRow('zones-drag-enabled', _('Show Zones While Dragging'),
                    _('Hold the modifier key while moving a window, then drop it into a zone')),
                comboRow('drag-modifier', _('Modifier Key'), MODIFIERS),
                spinRow('zone-gap', _('Gap'), 0, 48, 2, _('Space around windows in pixels')),
                switchRow('restore-size-on-drag', _('Restore Size'),
                    _('A window dragged out of its zone gets back its original size')),
                switchRow('snap-assist-enabled', _('Snap Assist'),
                    _('After snapping a window, pick the windows for the free zones')),
            ]),
            group(_('Corners'), [
                switchRow('corner-snap-enabled', _('Snap to Quarters'),
                    _('Drag a window to a corner of the screen to fill a quarter of it')),
                spinRow('corner-size', _('Corner Size'), 10, 300, 10,
                    _('Size in pixels of the area that triggers the snap')),
            ]),
            group(_('Top Bar'), [
                switchRow('show-indicator', _('Show Indicator')),
            ]),
        ]);

        // --- Layout --------------------------------------------------------

        const layoutsPage = new Adw.PreferencesPage({
            title: _('Layouts'), icon_name: 'view-grid-symbolic',
        });
        window.add(layoutsPage);
        this._buildLayoutsPage(window, layoutsPage, settings);

        // --- Scorciatoie ---------------------------------------------------

        const shortcut = (key, title) => new ShortcutRow(settings, key, title);
        const zoneRows = [];
        for (let n = 1; n <= 9; n++)
            zoneRows.push(shortcut(`move-to-zone-${n}`, _('Move to Zone %d').format(n)));

        page(_('Shortcuts'), 'preferences-desktop-keyboard-shortcuts-symbolic', [
            group(_('Zones'), [
                shortcut('move-zone-left', _('Move to the Zone on the Left')),
                shortcut('move-zone-right', _('Move to the Zone on the Right')),
                shortcut('move-zone-up', _('Move to the Zone Above')),
                shortcut('move-zone-down', _('Move to the Zone Below')),
                shortcut('apply-layout-all', _('Arrange All Windows in Zones')),
                shortcut('show-layout-picker', _('Layout Picker')),
            ]),
            group(_('Zone Number'), zoneRows),
            group(_('Windows'), [
                shortcut('toggle-always-on-top', _('Always on Top')),
            ]),
        ]);
    }

    _buildLayoutsPage(window, layoutsPage, settings) {
        const groups = [];

        const readCustom = () => parseCustomLayouts(settings.get_string('custom-layouts'));
        const writeCustom = list =>
            settings.set_string('custom-layouts', serializeCustomLayouts(list));

        const saveLayout = layout => {
            const list = readCustom();
            const i = list.findIndex(l => l.id === layout.id);
            if (i >= 0)
                list[i] = layout;
            else
                list.push(layout);
            writeCustom(list);
        };

        const deleteLayout = layout => {
            writeCustom(readCustom().filter(l => l.id !== layout.id));
            // I monitor che usavano il layout tornano a quello predefinito
            const active = parseJsonObject(settings.get_string('active-layouts'));
            for (const [connector, id] of Object.entries(active)) {
                if (id === layout.id)
                    delete active[connector];
            }
            settings.set_string('active-layouts', JSON.stringify(active));
            if (settings.get_string('default-layout') === layout.id)
                settings.reset('default-layout');
        };

        const newLayout = () => openLayoutEditor(window, {
            id: newLayoutId(), name: _('My Layout'),
            root: cloneNode(BUILTIN_LAYOUTS[0].root),
        }, saveLayout);

        const duplicate = layout => openLayoutEditor(window, {
            id: newLayoutId(),
            name: _('%s (copy)').format(_(layout.name)),
            root: cloneNode(layout.root),
        }, saveLayout);

        const layoutRow = (layout, custom) => {
            const row = new Adw.ActionRow({title: _(layout.name) || _('Untitled')});
            row.add_prefix(createPreview(layout.root));

            const button = (icon, tooltip, callback, classes = ['flat']) => {
                const b = new Gtk.Button({
                    icon_name: icon, tooltip_text: tooltip,
                    valign: Gtk.Align.CENTER, css_classes: classes,
                });
                b.connect('clicked', callback);
                row.add_suffix(b);
                return b;
            };

            if (custom) {
                button('document-edit-symbolic', _('Edit'),
                    () => openLayoutEditor(window, layout, saveLayout));
                button('edit-copy-symbolic', _('Duplicate'), () => duplicate(layout));
                button('user-trash-symbolic', _('Delete'), () => {
                    const dialog = new Adw.AlertDialog({
                        heading: _('Delete “%s”?').format(layout.name),
                        body: _('The layout will be removed permanently.'),
                    });
                    dialog.add_response('cancel', _('Cancel'));
                    dialog.add_response('delete', _('Delete'));
                    dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
                    dialog.connect('response', (_d, response) => {
                        if (response === 'delete')
                            deleteLayout(layout);
                    });
                    dialog.present(window);
                });
            } else {
                button('edit-copy-symbolic', _('Duplicate and Edit'), () => duplicate(layout));
            }
            return row;
        };

        const rebuild = () => {
            groups.forEach(g => layoutsPage.remove(g));
            groups.length = 0;

            const layouts = allLayouts(settings);
            const custom = readCustom();

            const defaultGroup = new Adw.PreferencesGroup({
                description: _('Each monitor remembers the layout chosen from the top bar ' +
                    'or the layout picker. Monitors without a choice use the default layout.'),
            });
            const ids = layouts.map(l => l.id);
            const defaultRow = new Adw.ComboRow({
                title: _('Default Layout'),
                model: Gtk.StringList.new(layouts.map(l => _(l.name) || _('Untitled'))),
                selected: Math.max(0, ids.indexOf(settings.get_string('default-layout'))),
            });
            defaultRow.connect('notify::selected', () => {
                const id = ids[defaultRow.selected];
                if (id && id !== settings.get_string('default-layout'))
                    settings.set_string('default-layout', id);
            });
            defaultGroup.add(defaultRow);

            const customGroup = new Adw.PreferencesGroup({
                title: _('Custom Layouts'),
                description: custom.length ? null : _('No custom layouts yet.'),
            });
            const add = new Gtk.Button({
                child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: _('New Layout')}),
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
            });
            add.connect('clicked', newLayout);
            customGroup.set_header_suffix(add);
            custom.forEach(l => customGroup.add(layoutRow(l, true)));

            const builtinGroup = new Adw.PreferencesGroup({title: _('Built-in Layouts')});
            BUILTIN_LAYOUTS.forEach(l => builtinGroup.add(layoutRow(l, false)));

            for (const g of [defaultGroup, customGroup, builtinGroup]) {
                layoutsPage.add(g);
                groups.push(g);
            }
        };

        settings.connect('changed::custom-layouts', rebuild);
        rebuild();
    }
}
