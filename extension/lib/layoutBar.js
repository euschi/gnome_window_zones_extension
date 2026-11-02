// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Barra con le miniature di tutti i layout, mostrata in alto mentre si trascina
// una finestra (stile Snap Layouts di Windows 11).
//
// Durante il grab di spostamento la Shell non riceve eventi del puntatore: la
// barra non è reattiva e dragSnap.js le chiede cosa c'è sotto il puntatore. Per
// questo le posizioni sono calcolate qui e non lasciate a un layout manager.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {zonesFromTree} from './layoutModel.js';
import {rectContains} from './utils.js';

const THUMB_WIDTH = 96;
const THUMB_PADDING = 6;
const THUMB_SPACING = 8;
const BAR_PADDING = 10;
const BAR_TOP_MARGIN = 6;
const ZONE_GAP = 2;
// Margine intorno alla barra entro cui resta aperta
const KEEP_OPEN_MARGIN = 16;
const MAX_WIDTH_RATIO = 0.9;

export class LayoutBar {
    constructor(zoneManager) {
        this._zones = zoneManager;
        this._actor = null;
        this._monitor = -1;
        this._rect = null;
        this._hits = [];
        this._active = null;
    }

    destroy() {
        this.hide();
    }

    get visible() {
        return this._actor !== null;
    }

    get monitor() {
        return this._monitor;
    }

    show(monitor) {
        if (this._actor && this._monitor === monitor)
            return;
        this.hide();

        const geometry = Main.layoutManager.monitors[monitor];
        if (!geometry)
            return;

        const layouts = this._zones.layouts;
        const area = this._zones.workArea(monitor);
        const thumbHeight = Math.round(THUMB_WIDTH * geometry.height / geometry.width);
        const cellWidth = THUMB_WIDTH + 2 * THUMB_PADDING;
        const cellHeight = thumbHeight + 2 * THUMB_PADDING;
        const fit = Math.floor((geometry.width * MAX_WIDTH_RATIO - 2 * BAR_PADDING + THUMB_SPACING) /
            (cellWidth + THUMB_SPACING));
        const columns = Math.max(1, Math.min(layouts.length, fit));
        const rows = Math.ceil(layouts.length / columns);
        const width = 2 * BAR_PADDING + columns * cellWidth + (columns - 1) * THUMB_SPACING;
        const height = 2 * BAR_PADDING + rows * cellHeight + (rows - 1) * THUMB_SPACING;
        const x = Math.round(geometry.x + (geometry.width - width) / 2);
        const y = area.y + BAR_TOP_MARGIN;

        this._monitor = monitor;
        this._rect = {x, y, width, height};
        this._actor = new St.Widget({style_class: 'winzones-layout-bar', x, y, width, height});

        const activeId = this._zones.layoutForMonitor(monitor).id;
        layouts.forEach((layout, i) => {
            const cellX = BAR_PADDING + (i % columns) * (cellWidth + THUMB_SPACING);
            const cellY = BAR_PADDING + Math.floor(i / columns) * (cellHeight + THUMB_SPACING);
            const cell = new St.Widget({
                style_class: 'winzones-layout-bar-thumb',
                x: cellX, y: cellY, width: cellWidth, height: cellHeight,
            });
            if (layout.id === activeId)
                cell.add_style_pseudo_class('checked');
            this._addZones(cell, layout, {
                x: x + cellX + THUMB_PADDING,
                y: y + cellY + THUMB_PADDING,
                width: THUMB_WIDTH,
                height: thumbHeight,
            });
            this._actor.add_child(cell);
        });

        Main.layoutManager.uiGroup.add_child(this._actor);
    }

    _addZones(cell, layout, thumb) {
        for (const [index, f] of zonesFromTree(layout.root).entries()) {
            const zoneX = Math.round(f.x * thumb.width + ZONE_GAP / 2);
            const zoneY = Math.round(f.y * thumb.height + ZONE_GAP / 2);
            const width = Math.max(1, Math.round(f.w * thumb.width - ZONE_GAP));
            const height = Math.max(1, Math.round(f.h * thumb.height - ZONE_GAP));
            const actor = new St.Widget({
                style_class: 'winzones-layout-bar-zone',
                x: THUMB_PADDING + zoneX, y: THUMB_PADDING + zoneY, width, height,
            });
            cell.add_child(actor);
            this._hits.push({
                layout, index, actor,
                rect: {x: thumb.x + zoneX, y: thumb.y + zoneY, width, height},
            });
        }
    }

    hide() {
        this._actor?.destroy();
        this._actor = null;
        this._monitor = -1;
        this._rect = null;
        this._hits = [];
        this._active = null;
    }

    // Puntatore sulla barra, sul margine intorno o più in alto (sul pannello):
    // risalendo verso il bordo la barra non deve chiudersi
    contains(x, y) {
        if (!this._rect)
            return false;
        const {x: left, y: top, width, height} = this._rect;
        return x >= left - KEEP_OPEN_MARGIN && x < left + width + KEEP_OPEN_MARGIN &&
            y < top + height + KEEP_OPEN_MARGIN;
    }

    // Evidenzia la zona sotto il puntatore e la restituisce: {layout, index, rect}
    update(x, y) {
        const hit = this._hits.find(h => rectContains(h.rect, x, y)) ?? null;
        if (hit !== this._active) {
            this._active?.actor.remove_style_pseudo_class('active');
            hit?.actor.add_style_pseudo_class('active');
            this._active = hit;
        }
        return hit;
    }
}
