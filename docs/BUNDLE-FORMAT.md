# Export bundle: `open-gallery-bundle` version 1

A complete, private backup of one workspace as an ordinary ZIP file. It opens with any unzip tool and its spreadsheets open in Excel, Numbers or Google Sheets, so the contents stay usable without Open Gallery.

```
manifest.json              format, version, app and schema version, workspace id, row counts,
                           and { path, sha256, bytes } for every other file
README.txt                 plain-language description and restore instructions
records/workspace.json     every table: meta, settings, artists, artworks, channel_links, media,
                           custom_fields, exhibitions, exhibition_items, imports, connectors, audit
spreadsheets/artworks.csv  one row per work including private fields, custom fields and extra columns
spreadsheets/artists.csv
spreadsheets/exhibitions.csv
media/originals/<sha256>.<ext>   every original image, byte for byte, named by checksum
imports/<import id>/<file>       every spreadsheet the gallery imported, unchanged
custom/…                         custom CSS and other customization files
```

Artwork records reference images by `media.sha256`, artists by `artist_id`, and exhibitions through `exhibition_items` with their order. `artworks.private`, `custom`, `extra` and `origin` are JSON objects; `dims` is a JSON list.

## Restore rules

- Restores only into an empty workspace.
- Every file is checked against the manifest's size and SHA-256 before any record is written. A missing or damaged file stops the restore.
- Records keep their original ids, so links, exhibition order and feed identifiers survive.
- After writing, the workspace is verified: every image present with the right checksum, every relationship intact, SQLite integrity check passing, row counts equal to the manifest.

Web-sized image copies and the built public site are not included; they are regenerated from originals.

Limit: bundles over 4 GB need ZIP64, which is not implemented yet. Very large archives should copy the data folder while the app is stopped.
