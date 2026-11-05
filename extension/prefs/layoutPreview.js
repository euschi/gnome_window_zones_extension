// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Draws a layout with Cairo, used by the thumbnails and by the editor.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {zonesFromTree} from '../lib/layoutModel.js';

const PREVIEW_WIDTH = 96;
const PREVIEW_HEIGHT = 54;

export function accentColor() {
    const c = Adw.StyleManager.get_default().get_accent_color_rgba();
    return [c.red, c.green, c.blue];
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// opts: {gap, radius, numbers, highlight (zone index)}
export function drawLayout(cr, width, height, root, {gap, radius, numbers = false, highlight = -1}) {
    const [r, g, b] = accentColor();
    const dark = Adw.StyleManager.get_default().dark;

    zonesFromTree(root).forEach((f, i) => {
        const x = f.x * width + gap / 2;
        const y = f.y * height + gap / 2;
        const w = f.w * width - gap;
        const h = f.h * height - gap;
        roundedRect(cr, x, y, w, h, radius);
        cr.setSourceRGBA(r, g, b, i === highlight ? 0.75 : 0.35);
        cr.fillPreserve();
        cr.setSourceRGBA(r, g, b, 0.9);
        cr.setLineWidth(1.5);
        cr.stroke();

        if (numbers) {
            const text = String(i + 1);
            cr.setFontSize(Math.max(10, Math.min(28, Math.min(w, h) / 3)));
            const ext = cr.textExtents(text);
            cr.moveTo(x + (w - ext.width) / 2 - ext.xBearing, y + (h - ext.height) / 2 - ext.yBearing);
            if (dark)
                cr.setSourceRGBA(1, 1, 1, 0.9);
            else
                cr.setSourceRGBA(0, 0, 0, 0.75);
            cr.showText(text);
        }
    });
}

export function createPreview(root) {
    const area = new Gtk.DrawingArea({
        content_width: PREVIEW_WIDTH,
        content_height: PREVIEW_HEIGHT,
        valign: Gtk.Align.CENTER,
    });
    area.set_draw_func((_a, cr, w, h) => {
        drawLayout(cr, w, h, root, {gap: 3, radius: 3});
        cr.$dispose();
    });
    return area;
}
