UUID      := winzones@euschi.github.io
DOMAIN    := winzones
SRC       := $(CURDIR)/extension
EXT_DIR   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

PO_FILES  := $(wildcard po/*.po)
MO_FILES  := $(patsubst po/%.po,$(SRC)/locale/%/LC_MESSAGES/$(DOMAIN).mo,$(PO_FILES))
JS_FILES  := $(SRC)/extension.js $(SRC)/prefs.js $(wildcard $(SRC)/lib/*.js) $(wildcard $(SRC)/prefs/*.js)
SCHEMA    := $(SRC)/schemas/org.gnome.shell.extensions.winzones.gschema.xml

.PHONY: all schemas locale pot install uninstall zip clean nested lint

all: schemas locale

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

# Traduzioni compilate in extension/locale/ (per l'installazione con symlink;
# lo zip le compila da sé con --podir)
locale: $(MO_FILES)

$(SRC)/locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	mkdir -p $(dir $@)
	msgfmt --check -o $@ $<

# Rigenera il template e aggiorna i .po esistenti con le stringhe nuove
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ --keyword=ngettext:1,2 \
		--add-comments=Translators --package-name=$(DOMAIN) --msgid-bugs-address=https://github.com/euschi/gnome_window_zones_extension/issues \
		-o po/$(DOMAIN).pot $(patsubst $(CURDIR)/%,%,$(JS_FILES))
	xgettext --from-code=UTF-8 --join-existing -o po/$(DOMAIN).pot \
		$(patsubst $(CURDIR)/%,%,$(SCHEMA))
	for po in $(PO_FILES); do msgmerge --update --backup=none $$po po/$(DOMAIN).pot; done

# Installazione di sviluppo: symlink della cartella extension/
install: schemas locale
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(SRC) $(EXT_DIR)
	@echo "Installata. Su Wayland: logout/login, poi: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(EXT_DIR)

zip: schemas
	mkdir -p dist
	gnome-extensions pack $(SRC) --force --out-dir=dist \
		--extra-source=lib --extra-source=prefs --podir=../po

# Shell annidata in una finestra per provare l'estensione senza logout
nested: install
	dbus-run-session gnome-shell --devkit --wayland

lint:
	[ -d node_modules ] || npm install --no-audit --no-fund
	npx eslint extension

clean:
	rm -rf dist $(SRC)/schemas/gschemas.compiled $(SRC)/locale
