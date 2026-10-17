# Implementation reference notes, checked 2026-10-16

Public documentation only.

## Reference projects for install, backup and upgrade

- **Mike** (github.com/open-legal-products/mike, AGPL-3.0): Docker Compose quick start; separate production guide; all model keys optional; Ollama as an OpenAI-compatible local option; dated migrations with "back up the database first". Borrowed: optional providers off by default, automatic numbered migrations, back-up-before-upgrade guidance. Not borrowed: Docker, Supabase and object storage (too much to operate for one gallery workstation), default-on telemetry.
- **Paperless-ngx**: `document_exporter` writes files plus `manifest.json`; `document_importer` requires a completely empty installation. Borrowed: manifest with checksums, restore only into empty workspace.
- **Immich**: database dumps alone are not a backup; the originals folder must be backed up too. Borrowed: one export containing both records and originals.
- **Nextcloud**: back up config, data, theme and database; no downgrades, restore into a fresh install instead. Borrowed: customization kept in the data folder and included in exports; refuse to open a newer-schema workspace.

## License

AGPL-3.0 chosen for the application, consistent with Mike, Immich, Paperless-ngx (GPL) and Nextcloud. It lets anyone run and change the software and requires a hosted modified version to share its source, which protects galleries from a closed hosted fork. It covers the code only, never gallery content. This is a reasoned choice, not legal advice.
