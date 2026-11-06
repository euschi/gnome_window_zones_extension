# Regole del progetto

## Zip per extensions.gnome.org

A ogni richiesta di zip da caricare sul sito, **prima di costruirlo aumenta
`version-name`** in `extension/metadata.json`, poi lancia `make zip`.

- Patch per soli fix (`0.1.0` → `0.1.1`), minor per nuove funzioni (`0.1.0` →
  `0.2.0`), major solo su richiesta esplicita.
- Non rifare mai uno zip da caricare con un numero già usato.
