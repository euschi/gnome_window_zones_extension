// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Bar with the thumbnails of all the layouts, shown at the top while dragging
// a window (in the style of Windows 11 Snap Layouts).
//
// During the move grab the Shell receives no pointer events: the bar isn't
// reactive and dragSnap.js asks it what is under the pointer. This is why the
// positions are computed here and not left to a layout manager.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {thumbnailRects} from './layoutModel.js';
import {rectContains} from './utils.js';

const THUMB_WIDTH = 96;
const THUMB_PADDING = 6;
const THUMB_SPACING = 8;
const BAR_PADDING = 10;
const BAR_TOP_MARGIN = 6;
const ZONE_GAP = 2;
// Margin around the bar within which it stays open
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

    get monitor() {
        return this._monitor;
    }

    show(monitor) {
        if (this._actor && this._monitor === monitor)
            return;
        this.hide();

        const geometry = Main.layoutManager.monitors[monitor];
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
        const rects = thumbnailRects(layout.root, thumb.width, thumb.height, ZONE_GAP);
        for (const [index, {x: zoneX, y: zoneY, width, height}] of rects.entries()) {
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

    // Pointer on the bar, on the margin around it or higher (on the panel):
    // the bar must not close when moving back up towards the edge
    contains(x, y) {
        if (!this._rect)
            return false;
        const {x: left, y: top, width, height} = this._rect;
        return x >= left - KEEP_OPEN_MARGIN && x < left + width + KEEP_OPEN_MARGIN &&
            y < top + height + KEEP_OPEN_MARGIN;
    }

    // Highlight the zone under the pointer and return it: {layout, index, rect}
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
