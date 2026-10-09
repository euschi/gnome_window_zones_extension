// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Eugenio Schintu

// Doppio clic sul bordo di ridimensionamento → massimizzazione in una sola
// direzione, come su Windows (alto/basso: verticale, sinistra/destra:
// orizzontale).
//
// Su Wayland i bordi delle finestre con decorazioni lato client appartengono
// al client, quindi la Shell non riceve i clic. Ogni pressione sul bordo però
// fa partire un grab di ridimensionamento di Mutter: due grab sullo stesso lato
// della stessa finestra, ravvicinati e senza variazione di dimensione, sono un
// doppio clic. Si agisce alla fine del secondo grab, così non c'è nessun grab
// da annullare.
//
// Una volta massimizzata in una sola direzione la finestra non ha più un bordo
// cliccabile su quel lato (finisce sotto il pannello o fuori schermo) e Mutter
// la blocca su quell'asse: trascinandola lungo l'asse bloccato, al rilascio
// torna alla dimensione di prima, sotto il puntatore.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {GrabOpBits, frameRectEquals, isPointerMove} from './utils.js';

// Spostamento minimo del puntatore lungo l'asse bloccato per ripristinare
const UNMAXIMIZE_DRAG_DISTANCE = 40;

export class EdgeDoubleClick {
    constructor(settings) {
        this._settings = settings;
        this._press = null;     // grab di resize in corso
        this._lastClick = null; // ultimo "clic" (grab senza ridimensionamento)
        this._idleId = 0;
        this._move = null;      // spostamento di una finestra massimizzata a metà
        this._saved = new Map(); // finestra → dimensione prima della massimizzazione
        this._mouseSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'});

        global.display.connectObject(
            'grab-op-begin', (_d, window, op) => this._onGrabBegin(window, op),
            'grab-op-end', (_d, window, op) => this._onGrabEnd(window, op),
            this);
    }

    destroy() {
        global.display.disconnectObject(this);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._press = null;
        this._lastClick = null;
        this._move = null;
        for (const window of this._saved.keys())
            window.disconnectObject(this);
        this._saved.clear();
        this._mouseSettings = null;
    }

    _edgeOf(op) {
        if (op & GrabOpBits.KEYBOARD)
            return null;
        switch (op & GrabOpBits.EDGES) {
        case GrabOpBits.NORTH:
        case GrabOpBits.SOUTH:
            return 'vertical';
        case GrabOpBits.EAST:
        case GrabOpBits.WEST:
            return 'horizontal';
        default:
            return null; // angoli o spostamento
        }
    }

    _onGrabBegin(window, op) {
        this._move = null;
        if (window && isPointerMove(op) && this._singleAxis(window)) {
            const [x, y] = global.get_pointer();
            this._move = {window, x, y, rect: window.get_frame_rect()};
        }

        const edge = this._edgeOf(op);
        if (!window || !edge || !this._settings.get_boolean('edge-dblclick-enabled')) {
            this._press = null;
            return;
        }
        this._press = {
            window, edge,
            side: op & GrabOpBits.EDGES,
            rect: window.get_frame_rect(),
            time: GLib.get_monotonic_time(),
        };
    }

    _singleAxis(window) {
        const flags = window.get_maximize_flags();
        return flags === Meta.MaximizeFlags.VERTICAL || flags === Meta.MaximizeFlags.HORIZONTAL;
    }

    _onGrabEnd(window, _op) {
        const move = this._move;
        this._move = null;
        if (move && move.window === window)
            this._maybeRestoreAfterMove(move);

        const press = this._press;
        this._press = null;
        if (!press || press.window !== window)
            return;

        // Un ridimensionamento vero non è un clic
        if (!frameRectEquals(window.get_frame_rect(), press.rect, 2)) {
            this._lastClick = null;
            return;
        }

        const last = this._lastClick;
        const maxDelay = this._mouseSettings.get_int('double-click') * 1000;
        if (last && last.window === window && last.side === press.side &&
            press.time - last.time <= maxDelay) {
            this._lastClick = null;
            this._schedule(window, press.edge);
        } else {
            this._lastClick = press;
        }
    }

    _schedule(window, edge) {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._toggle(window, edge);
            return GLib.SOURCE_REMOVE;
        });
    }

    _toggle(window, edge) {
        if (edge === 'horizontal' && !this._settings.get_boolean('edge-dblclick-horizontal'))
            return;
        if (!window.get_compositor_private() || !window.can_maximize())
            return;

        const flag = edge === 'vertical'
            ? Meta.MaximizeFlags.VERTICAL : Meta.MaximizeFlags.HORIZONTAL;
        if (window.get_maximize_flags() & flag) {
            window.unmaximize();
            this._forget(window);
            return;
        }
        if (!window.get_maximize_flags()) {
            const {width, height} = window.get_frame_rect();
            if (!this._saved.has(window))
                window.connectObject('unmanaged', () => this._forget(window), this);
            this._saved.set(window, {width, height});
        }
        window.set_maximize_flags(flag);
    }

    _forget(window) {
        if (this._saved.delete(window))
            window.disconnectObject(this);
    }

    _maybeRestoreAfterMove(move) {
        const {window} = move;
        const flags = window.get_maximize_flags();
        if (!this._singleAxis(window))
            return;
        const vertical = flags === Meta.MaximizeFlags.VERTICAL;
        const [x, y] = global.get_pointer();
        const distance = vertical ? y - move.y : x - move.x;
        if (Math.abs(distance) < UNMAXIMIZE_DRAG_DISTANCE)
            return;

        const current = window.get_frame_rect();
        const saved = this._saved.get(window) ?? {
            width: vertical ? current.width : Math.round(current.width * 2 / 3),
            height: vertical ? Math.round(current.height * 2 / 3) : current.height,
        };
        this._forget(window);

        // Il puntatore resta alla stessa distanza dal bordo superiore (barra
        // del titolo) e nella stessa posizione relativa in orizzontale
        const relX = move.rect.width ? (move.x - move.rect.x) / move.rect.width : 0.5;
        const area = window.get_work_area_current_monitor();
        const newX = vertical ? current.x : Math.max(area.x, Math.min(
            Math.round(x - relX * saved.width), area.x + area.width - saved.width));
        const newY = vertical
            ? Math.round(y - Math.min(move.y - move.rect.y, saved.height / 2))
            : current.y;
        window.unmaximize();
        window.move_resize_frame(true, newX, newY, saved.width, saved.height);
    }
}
