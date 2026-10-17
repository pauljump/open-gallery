# Open Gallery: contract for developers and assistants

Open Gallery is a free (AGPL-3.0) local inventory and catalog application for galleries. One maintained package serves every gallery; galleries customize through settings, not forks.

## If you are an assistant helping a gallery owner install it

All commands run from the app folder as `node bin/open-gallery.mjs <command>`. `doctor` creates nothing.

1. Run `node bin/open-gallery.mjs doctor`. If Node.js is older than 22.13, explain how to install it from nodejs.org and stop until it is installed.
2. Keep the code and the data apart. Data goes in `~/Open Gallery` unless the owner names another folder (`--data FOLDER`). Never put gallery files inside the code folder. After `start` or `demo` with `--data`, that folder is remembered in `~/.config/open-gallery/config.json`, so later commands can omit `--data`.
3. Ask for a **copy** of the inventory spreadsheet (CSV or .xlsx) and image folder. Never edit the owner's original files. If they have none, run `node bin/open-gallery.mjs demo --open`.
4. Preview first: `node bin/open-gallery.mjs import COPY.xlsx --data DIR` prints the mapping, the summary and every row that needs a person (errors, possible duplicates, conflicts, sold works the sheet calls available). The catalog is unchanged; a copy of the file is kept in the import history. Tell the owner about those rows in plain words. Duplicates must be decided in the app (`start --open`, **Import**). Use `--apply` only when no duplicates need deciding and the owner agreed; rows with errors are skipped.
5. Images: add `--images FOLDER` to the `--apply` run (images are matched to works, so they are only imported once the works exist), or use **Import > Images** in the app. Files are matched by inventory number (`GL-1001.jpg`, `GL-1001_2.jpg`). Unmatched images wait in the app for manual assignment.
6. Publish and assemble without the browser if needed:
   - `node bin/open-gallery.mjs publish-works --availability available` (or `--all`, or inventory numbers; `--private` reverses).
   - `node bin/open-gallery.mjs exhibition "Small Hours" --works GL-1001,GL-1002 --dates "May 1 – June 2" --publish` prints the printable catalog address (`http://localhost:4380/print/exhibitions/<id>` while the app runs).
   - `node bin/open-gallery.mjs build-site` writes the public folder to `DIR/site`. Building from the app (Publish) also makes web-sized image copies, which strips camera metadata and shrinks the site; the command line build uses originals and warns about original JPEGs.
   - The HTTP API (`server.mjs`) accepts the same operations; mutating requests need the header `x-open-gallery: 1`.
7. Customize with settings, never by editing application files:
   - `node bin/open-gallery.mjs settings` lists every setting.
   - `node bin/open-gallery.mjs settings set theme.colorAccent '#7a3e2b' --data DIR`
   - Fonts: `theme.headingFont` / `theme.bodyFont` in `classic-serif | modern-serif | neo-grotesque | humanist | system | mono`. Layout `theme.layout` in `grid | list | salon`.
   - Anything else visual: write CSS to `DIR/custom/site.css` (kept across updates and included in exports). Never use `<script>` or remote fonts there.
   - New fields: Settings > Your own fields, with an explicit private/public choice.
8. Prove recovery: `export --out /tmp/og-test.zip`, then `restore /tmp/og-test.zip --data /tmp/og-restore-test`, confirm `"ok": true`, then delete both test copies.
9. Ask before anything public or paid: uploading the built site, buying a domain, choosing a host, enabling any AI provider. There is no paid call anywhere in the core app.
10. Do not log into the gallery's marketplace accounts, scrape marketplaces, or claim a sync. Listing links are kept; marketplace upload files are uploaded by the owner.

## Architecture

- Node 22 built-ins only (`node:http`, `node:sqlite`, `node:zlib`). No runtime packages, no build step, no network calls.
- `server.mjs` serves the app on 127.0.0.1 only, rejects other Host headers and mutating requests without the `x-open-gallery: 1` header.
- `lib/db.mjs` numbered migrations run at startup in a transaction. A workspace from a newer schema refuses to open rather than being damaged.
- `lib/fields.mjs` is the field registry. Every field is `public` or `private`. Add new private data there as `private`.
- `lib/site.mjs` `publicArtwork()` is the **only** path to public output and is an allowlist. Never read `private`, `extra`, `origin` or location in public code. `test/privacy.test.mjs` scans every built file for seeded private values.
- `lib/importer.mjs` preview/apply. Per-field origin tracking (`origin[field] = {by, imported}`) is how re-imports distinguish sheet edits from staff edits. Sold works are never un-sold by an import without an explicit per-field choice. Missing rows are flagged, never deleted.
- `lib/backup.mjs` export ZIP with SHA-256 manifest; restore only into an empty workspace, verifying every file first.
- `lib/artsy.mjs` marketplace file exchange only. Connector states: `not_connected`, `file_exchange`, `api_connected` (unused until real authorized access exists), `attention`.

## Rules

- No paid or quota-consuming call may be added to a core path. Optional AI must be off by default, owner-configured, and never fall back silently to a paid provider.
- Keep public claims in `docs/CLAIMS.md` tied to a test or a measured result.
- Do not describe file exchange as an integration or a sync.

## Commands

`npm test` · `npm run build` (syntax check) · `node bin/open-gallery.mjs help`
