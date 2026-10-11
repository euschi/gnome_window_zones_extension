# Window Zones — GNOME Shell extension

Windows-style window management for GNOME: **vertical maximize with a double
click on the resize border**, **zone layouts** like FancyZones / Snap Layouts
(built-in plus your own, drawn in a visual editor), **Snap Assist**, **quarter
snapping in the corners** and a few handy shortcuts.

- **UUID:** `winzones@euschi.github.io`
- **Supported GNOME Shell:** 51 (Wayland session)
- **License:** GPL-2.0-or-later (see [`LICENSE`](LICENSE))
- **Repository:** <https://github.com/euschi/gnome_window_zones_extension>

The user interface is in English and follows the system language when a
translation is available (currently: Italian).

---

## Features

**Double click on the border**
- Double click the **top or bottom** border (where the resize cursor appears)
  to maximize the window **vertically only**, like on Windows.
- Double click the **left or right** border to maximize it **horizontally**
  (can be turned off).
- To restore it, drag the window along the maximized direction (up/down for a
  vertically maximized window, left/right for a horizontal one): on release it
  gets back its previous size under the pointer.

**Zone layouts**
- Every monitor has its own layout. Built-in layouts: Halves, Thirds,
  Grid 2×2, One Third + Two Thirds, Two Thirds + One Third, Main + Side Stack,
  Priority (25/50/25), Four Columns (ultrawide), Grid 3×2.
- **Custom layouts** made in a visual editor (Settings → Layouts): click a zone
  to split it into columns, Shift+click to split it into rows, right click
  (or Ctrl+click) to merge it, drag the lines to resize. Undo with Ctrl+Z.
- Gap between windows configurable.

**Putting windows into zones**
- **Drag + Shift** (modifier configurable): the zones appear while you move the
  window; drop it on a zone to fill it.
- **Layout picker** (`Super+Z`): thumbnails of all layouts, click a zone to send
  the focused window there and make that layout the active one for the monitor.
- **Keyboard:** `Super+Ctrl+←/→/↑/↓` moves the window to the neighbouring zone
  (and on to the next monitor at the edge), `Super+Ctrl+Alt+1…9` sends it to
  zone N.
- **Arrange all** (`Super+Ctrl+A` or the top bar menu): distributes the windows
  of the monitor into the zones.

**Extras**
- **Snap Assist:** after snapping a window, the free zones show the other
  windows as thumbnails; click one to put it there (Esc to dismiss).
- **Quarter snapping:** drag a window into a screen corner to fill a quarter.
  Dropping on the side edges keeps GNOME's usual half tiling.
- **Restore size:** a window dragged out of its zone gets back its original
  size.
- **Linked resizing:** dragging the border of a window resizes the windows
  next to it on that side too, keeping the gap between them.
- **Window menu** (right click on the title bar): a thumbnail of the active
  layout to send the window to a zone, a *Layout* submenu with every layout
  (click a zone to switch layout and place the window in one go, click the name
  to switch layout only) and **Swap with “…”** to exchange position and size
  with a window placed right next to it.
- **Always on top:** `Super+Ctrl+T` toggles it for the focused window.
- **Top bar indicator** with the layout of each monitor and quick actions.

All shortcuts can be changed in Settings → Shortcuts.

---

## Requirements

- GNOME Shell **51**
- `glib-compile-schemas` and `msgfmt` (gettext) to build from source
- Node.js only for `make lint` (development)

## Installation

From source (development install, a symlink to `extension/`):

```sh
make install
```

On **Wayland** log out and back in, then:

```sh
gnome-extensions enable winzones@euschi.github.io
```

To build a zip for distribution / extensions.gnome.org:

```sh
make zip        # → dist/winzones@euschi.github.io.shell-extension.zip
gnome-extensions install --force dist/winzones@euschi.github.io.shell-extension.zip
```

Uninstall with `make uninstall`.

## Settings

Open them from the top bar indicator (Settings) or with:

```sh
gnome-extensions prefs winzones@euschi.github.io
```

| Page | What you can change |
|------|---------------------|
| General | Double click on top/bottom and left/right borders, zones while dragging, modifier key, gap, restore size, Snap Assist, quarter snapping and corner size, window menu items, indicator |
| Layouts | Default layout, custom layouts (new, edit, duplicate, delete), duplicate a built-in layout to customize it |
| Shortcuts | Every keyboard shortcut (Backspace in the capture dialog disables it) |

Default shortcuts:

| Shortcut | Action |
|----------|--------|
| `Super+Z` | Layout picker |
| `Super+Ctrl+←/→/↑/↓` | Move the window to the neighbouring zone |
| `Super+Ctrl+Alt+1…9` | Move the window to zone 1…9 |
| `Super+Ctrl+A` | Arrange all windows of the monitor in the zones |
| `Super+Ctrl+T` | Always on top |

---

## How it works (architecture)

```
extension/
  extension.js           enable/disable, wires the components together
  prefs.js               settings window (Adw)
  stylesheet.css         overlay, Snap Assist and picker styles (system accent color)
  lib/layoutModel.js     layout model shared with prefs (pure JS, no Shell imports)
  lib/zoneManager.js     zone geometry per monitor, window placement, snapped-window state
  lib/edgeDoubleClick.js double click on the resize border
  lib/dragSnap.js        zones while dragging, quarter snapping, restore size
  lib/zoneOverlay.js     zones drawn over the windows
  lib/snapAssist.js      Snap Assist
  lib/layoutPicker.js    layout picker (Super+Z)
  lib/keybindings.js     keyboard shortcuts
  lib/indicator.js       top bar menu
  lib/windowMenu.js      zones, layouts and swap in the window menu (title bar right click)
  prefs/layoutEditor.js  visual layout editor (Gtk.DrawingArea + Cairo)
  prefs/layoutPreview.js layout thumbnails
  prefs/shortcutRow.js   shortcut capture row
  schemas/               GSettings schema
po/                      translations (gettext)
```

- **Layouts** are trees of splits: `{dir: 'cols'|'rows', sizes: [...], children: [...]}`
  with `{zone: true}` leaves; zones are numbered depth-first. Custom layouts
  are stored as JSON in the `custom-layouts` key, the layout of each monitor
  in `active-layouts` (keyed by connector name, e.g. `DP-1`).
- **Double click on the border:** on Wayland the resize borders of
  client-side decorated windows belong to the application, so the Shell never
  sees those clicks. Every press on the border, though, starts a Mutter resize
  grab: two resize grabs on the same edge of the same window, within the
  system double-click time and without any size change, are a double click.
  The window is then maximized with `Meta.Window.set_maximize_flags()`.
- **Dragging:** during a move grab Mutter does not pass pointer events to the
  Shell, so the pointer position and modifiers are polled (`global.get_pointer()`)
  while the grab lasts. Placement happens after the grab ends, so it always
  wins over GNOME's own edge tiling.

## Development and debugging

```sh
make lint       # eslint (installs the dev dependencies on first run)
make schemas    # compile the GSettings schema
make pot        # regenerate po/winzones.pot and merge the .po files
make nested     # GNOME Shell in a window (devkit) to try the extension without logging out
journalctl -f -o cat /usr/bin/gnome-shell   # Shell logs
```

The extension can also be tested in a fully isolated headless Shell
(`gnome-shell --headless --wayland --virtual-monitor 1920x1080`) inside
`dbus-run-session`, with `XDG_CONFIG_HOME`/`XDG_DATA_HOME` pointing to a
throw-away directory so your real settings are never touched.

## Translations

1. `make pot` to refresh `po/winzones.pot`.
2. Copy it to `po/<lang>.po` (or update the existing file), translate,
   add the language to `po/LINGUAS`.
3. `make locale` for the development install; `make zip` compiles them by
   itself.

## Known limitations

- The double click on the border works with applications that start a
  compositor resize on every press of the border (GTK 3/4, Qt, most
  toolkits). An application that handled the second click itself without
  starting a resize would not trigger it.
- A window maximized in one direction has no clickable border on that side
  any more (it lies under the top bar or off screen), so it is restored by
  dragging, not by another double click.
- The original size of a window dragged out of a zone is restored when the
  window is dropped, not while dragging.
- When a window is dropped into a corner, GNOME may tile it to a half for an
  instant before it is moved to the quarter.
