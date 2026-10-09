// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Editor visuale dei layout:
// - clic su una zona: la divide in colonne nel punto cliccato;
// - Shift+clic: la divide in righe;
// - clic destro o Ctrl+clic: la unisce alla zona vicina;
// - trascinando le linee tra le zone si cambiano le proporzioni.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    BUILTIN_LAYOUTS, MIN_SIZE, cloneNode, countZones, zone,
} from '../lib/layoutModel.js';
import {accentColor, drawLayout} from './layoutPreview.js';

const DIVIDER_HIT = 7;
const CLICK_THRESHOLD = 4;
const MAX_ZONES = 16;

// --- Operazioni sull'albero -----------------------------------------------

function nodeAt(root, path) {
    return path.reduce((node, i) => node.children[i], root);
}

// Unisce le divisioni annidate nella stessa direzione ed elimina quelle con un
// solo figlio, così l'albero resta minimo
function normalize(node) {
    if (node.zone)
        return node;
    const children = [];
    const sizes = [];
    node.children.forEach((child, i) => {
        child = normalize(child);
        if (!child.zone && child.dir === node.dir) {
            child.children.forEach((c, j) => {
                children.push(c);
                sizes.push(child.sizes[j] * node.sizes[i]);
            });
        } else {
            children.push(child);
            sizes.push(node.sizes[i]);
        }
    });
    if (children.length === 1)
        return children[0];
    return {dir: node.dir, sizes, children};
}

function geometry(root, width, height) {
    const leaves = [];
    const dividers = [];
    const walk = (node, rect, path) => {
        if (node.zone) {
            leaves.push({path, rect});
            return;
        }
        let offset = 0;
        node.children.forEach((child, i) => {
            const size = node.sizes[i];
            const sub = node.dir === 'cols'
                ? {x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h}
                : {x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h};
            walk(child, sub, [...path, i]);
            offset += size;
            if (i < node.children.length - 1) {
                dividers.push({
                    path, index: i, dir: node.dir, rect,
                    pos: node.dir === 'cols' ? rect.x + offset * rect.w : rect.y + offset * rect.h,
                });
            }
        });
    };
    walk(root, {x: 0, y: 0, w: width, h: height}, []);
    return {leaves, dividers};
}

// --- Widget del canvas ----------------------------------------------------

const LayoutCanvas = GObject.registerClass({
    Signals: {'changed': {}},
}, class LayoutCanvas extends Gtk.DrawingArea {
    _init(root) {
        super._init({hexpand: true, vexpand: true, focusable: true});
        this.tree = cloneNode(root);
        this._history = [];
        this._hover = -1;
        this._drag = null;

        this.set_draw_func((_a, cr, w, h) => {
            this._draw(cr, w, h);
            cr.$dispose();
        });

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_c, x, y) => this._onMotion(x, y));
        motion.connect('leave', () => {
            this._hover = -1;
            this.queue_draw();
        });
        this.add_controller(motion);

        const drag = new Gtk.GestureDrag({button: 0});
        drag.connect('drag-begin', (g, x, y) => this._onDragBegin(g, x, y));
        drag.connect('drag-update', (g, dx, dy) => this._onDragUpdate(dx, dy));
        drag.connect('drag-end', (g, dx, dy) => this._onDragEnd(g, dx, dy));
        this.add_controller(drag);
    }

    setRoot(root) {
        this._pushHistory();
        this.tree = cloneNode(root);
        this._changed();
    }

    undo() {
        if (this._history.length === 0)
            return;
        this.tree = JSON.parse(this._history.pop());
        this._changed();
    }

    get canUndo() {
        return this._history.length > 0;
    }

    _pushHistory() {
        this._history.push(JSON.stringify(this.tree));
        if (this._history.length > 100)
            this._history.shift();
    }

    _changed() {
        this.queue_draw();
        this.emit('changed');
    }

    _geometry() {
        return geometry(this.tree, this.get_width(), this.get_height());
    }

    _dividerAt(x, y) {
        let best = null, bestDistance = DIVIDER_HIT;
        for (const d of this._geometry().dividers) {
            const inside = d.dir === 'cols'
                ? y >= d.rect.y && y <= d.rect.y + d.rect.h
                : x >= d.rect.x && x <= d.rect.x + d.rect.w;
            const distance = Math.abs((d.dir === 'cols' ? x : y) - d.pos);
            if (inside && distance <= bestDistance) {
                best = d;
                bestDistance = distance;
            }
        }
        return best;
    }

    _leafAt(x, y) {
        return this._geometry().leaves.findIndex(l =>
            x >= l.rect.x && x < l.rect.x + l.rect.w && y >= l.rect.y && y < l.rect.y + l.rect.h);
    }

    _onMotion(x, y) {
        if (this._drag)
            return;
        const divider = this._dividerAt(x, y);
        this.set_cursor_from_name(divider
            ? divider.dir === 'cols' ? 'col-resize' : 'row-resize'
            : 'crosshair');
        const hover = divider ? -1 : this._leafAt(x, y);
        if (hover !== this._hover) {
            this._hover = hover;
            this.queue_draw();
        }
    }

    _onDragBegin(_gesture, x, y) {
        this.grab_focus();
        const divider = this._dividerAt(x, y);
        this._drag = {x, y, divider, moved: false};
        if (divider) {
            this._pushHistory();
            this._drag.startSizes = [...nodeAt(this.tree, divider.path).sizes];
        }
    }

    _onDragUpdate(dx, dy) {
        const drag = this._drag;
        if (!drag)
            return;
        if (Math.abs(dx) > CLICK_THRESHOLD || Math.abs(dy) > CLICK_THRESHOLD)
            drag.moved = true;
        if (!drag.divider || !drag.moved)
            return;

        const {path, index, dir, rect} = drag.divider;
        const node = nodeAt(this.tree, path);
        const length = dir === 'cols' ? rect.w : rect.h;
        const pair = drag.startSizes[index] + drag.startSizes[index + 1];
        let a = drag.startSizes[index] + (dir === 'cols' ? dx : dy) / length;
        // Aggancio a passi dell'1%
        a = Math.round(a * 100) / 100;
        a = Math.max(MIN_SIZE, Math.min(pair - MIN_SIZE, a));
        node.sizes[index] = a;
        node.sizes[index + 1] = pair - a;
        this.queue_draw();
    }

    _onDragEnd(gesture, _dx, _dy) {
        const drag = this._drag;
        this._drag = null;
        if (!drag)
            return;
        if (drag.divider) {
            if (drag.moved)
                this._changed();
            else
                this._history.pop();
            return;
        }
        if (drag.moved)
            return;

        // È un clic su una zona
        const index = this._leafAt(drag.x, drag.y);
        if (index < 0)
            return;
        const leaf = this._geometry().leaves[index];
        const state = gesture.get_current_event_state();
        const button = gesture.get_current_button();

        if (button === Gdk.BUTTON_SECONDARY || (state & Gdk.ModifierType.CONTROL_MASK))
            this._merge(leaf.path);
        else if (state & Gdk.ModifierType.SHIFT_MASK)
            this._split(leaf.path, 'rows', (drag.y - leaf.rect.y) / leaf.rect.h);
        else if (button === Gdk.BUTTON_PRIMARY)
            this._split(leaf.path, 'cols', (drag.x - leaf.rect.x) / leaf.rect.w);
    }

    _split(path, dir, ratio) {
        if (countZones(this.tree) >= MAX_ZONES)
            return;
        ratio = Math.round(ratio * 100) / 100;
        if (ratio < MIN_SIZE * 2 || ratio > 1 - MIN_SIZE * 2)
            return;
        this._pushHistory();

        const parent = path.length ? nodeAt(this.tree, path.slice(0, -1)) : null;
        const i = path[path.length - 1];
        if (parent && parent.dir === dir) {
            const size = parent.sizes[i];
            parent.children.splice(i + 1, 0, zone());
            parent.sizes.splice(i, 1, size * ratio, size * (1 - ratio));
        } else {
            const node = {dir, sizes: [ratio, 1 - ratio], children: [zone(), zone()]};
            if (parent)
                parent.children[i] = node;
            else
                this.tree = node;
        }
        this.tree = normalize(this.tree);
        this._changed();
    }

    _merge(path) {
        if (!path.length)
            return;
        this._pushHistory();
        const parent = nodeAt(this.tree, path.slice(0, -1));
        const i = path[path.length - 1];
        const neighbour = i > 0 ? i - 1 : i + 1;
        parent.sizes[neighbour] += parent.sizes[i];
        parent.sizes.splice(i, 1);
        parent.children.splice(i, 1);
        this.tree = normalize(this.tree);
        this._changed();
    }

    _draw(cr, width, height) {
        drawLayout(cr, width, height, this.tree, {
            gap: 8, radius: 8, numbers: true, highlight: this._hover,
        });
        // Linee di divisione trascinabili
        const [r, g, b] = accentColor();
        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(3);
        cr.setLineCap(1); // ROUND
        for (const d of geometry(this.tree, width, height).dividers) {
            const middle = d.dir === 'cols' ? d.rect.y + d.rect.h / 2 : d.rect.x + d.rect.w / 2;
            const half = Math.min(18, (d.dir === 'cols' ? d.rect.h : d.rect.w) / 4);
            if (d.dir === 'cols') {
                cr.moveTo(d.pos, middle - half);
                cr.lineTo(d.pos, middle + half);
            } else {
                cr.moveTo(middle - half, d.pos);
                cr.lineTo(middle + half, d.pos);
            }
            cr.stroke();
        }
    }
});

// --- Finestra di dialogo --------------------------------------------------

// layout: {id, name, root}; onSave(layout) riceve il layout modificato
export function openLayoutEditor(parent, layout, onSave) {
    const dialog = new Adw.Dialog({
        title: _('Edit Layout'),
        content_width: 820,
        content_height: 680,
    });

    const canvas = new LayoutCanvas(layout.root);

    const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
    const cancel = new Gtk.Button({label: _('Cancel')});
    cancel.connect('clicked', () => dialog.close());
    header.pack_start(cancel);
    const save = new Gtk.Button({label: _('Save'), css_classes: ['suggested-action']});
    header.pack_end(save);
    const undo = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: _('Undo'),
        sensitive: false,
    });
    undo.connect('clicked', () => canvas.undo());
    header.pack_end(undo);

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12, margin_bottom: 18, margin_start: 18, margin_end: 18,
    });

    const group = new Adw.PreferencesGroup();
    const nameRow = new Adw.EntryRow({title: _('Name'), text: layout.name});
    group.add(nameRow);

    // La prima voce lascia le zone come sono: scegliere un modello le sostituisce
    const templates = [
        {name: _('Keep Current Zones'), root: null},
        {name: _('Single Zone'), root: zone()},
        ...BUILTIN_LAYOUTS.map(l => ({name: _(l.name), root: l.root})),
    ];
    const templateRow = new Adw.ComboRow({
        title: _('Start From'),
        subtitle: _('Replaces the current zones'),
        model: Gtk.StringList.new(templates.map(t => t.name)),
        selected: 0,
    });
    templateRow.connect('notify::selected', () => {
        const t = templates[templateRow.selected];
        if (t?.root)
            canvas.setRoot(t.root);
    });
    group.add(templateRow);
    content.append(group);

    content.append(new Gtk.Label({
        label: _('Click a zone to split it into columns, Shift+click to split it into rows, ' +
            'right-click (or Ctrl+click) to merge it with the zone next to it. ' +
            'Drag the lines between zones to resize them.'),
        wrap: true,
        xalign: 0,
        css_classes: ['dim-label'],
    }));

    const counter = new Gtk.Label({xalign: 1, css_classes: ['dim-label', 'caption']});
    const update = () => {
        const n = countZones(canvas.tree);
        counter.label = ngettext('%d zone', '%d zones', n).format(n);
        undo.sensitive = canvas.canUndo;
    };
    canvas.connect('changed', update);
    update();

    const frame = new Gtk.AspectFrame({
        ratio: 16 / 9, obey_child: false, hexpand: true, vexpand: true,
        child: canvas,
    });
    content.append(frame);
    content.append(counter);

    const shortcuts = new Gtk.ShortcutController();
    shortcuts.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('<Control>z'),
        action: Gtk.CallbackAction.new(() => {
            canvas.undo();
            return true;
        }),
    }));
    dialog.add_controller(shortcuts);

    const toolbar = new Adw.ToolbarView({content});
    toolbar.add_top_bar(header);
    dialog.set_child(toolbar);

    const validate = () => {
        save.sensitive = nameRow.text.trim().length > 0;
    };
    nameRow.connect('changed', validate);
    validate();

    save.connect('clicked', () => {
        onSave({...layout, name: nameRow.text.trim(), root: cloneNode(canvas.tree)});
        dialog.close();
    });

    dialog.present(parent);
}
