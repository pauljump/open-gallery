# Implementation-critical facts, checked 2026-10-16

Public documentation only. No gallery account, partner credential or live integration was used.

## Artsy

- **Bulk import** (partners.artsy.net/product-updates/bulk-import-launch; /bulk-import-updates; /beta-test-bulk-import): one row per artwork, up to 100 per import; .xlsx recommended or .csv. Required: artist name, artwork title, year (single year or range), price (numbers only; currency from account settings; ranges like `5000 - 7500`). Optional fields named: Inventory ID, Medium, Materials, Artwork Dimensions, Framed Dimensions, Certificate of Authenticity, Weight, Artwork Condition, Signature, Classification, Series, Description, Exhibition History, Bibliography, Provenance, Image Rights, Image Files. Images matched by file names listed in "Image Files", separated by `,` or `|`. Units and currency set per batch or artwork in Edit Import Settings. Availability and shipping are completed in CMS after import. Unique works only.
- **Not verified:** the current CMS template's exact headers (needs a partner login; only the older public template at files.artsy.net was read, which has 10 columns). Open Gallery's file follows the documented field names and relies on Artsy's on-screen column mapping.
- **API:** developers.artsy.net states the public API is being retired and partner API integrations are not affected; partner galleries are directed to their Artsy liaison. The API v1 samples repository describes access granted by Artsy and "not for public consumption". Conclusion: no self-serve API path; file exchange is the honest integration until access is granted.
- **Terms** (artsy.net/terms, as summarized in the research brief): users retain their intellectual-property rights in content they upload while granting Artsy a broad license. Open Gallery's public copy must not claim Artsy owns uploaded artwork.

## Artnet

- No public inventory write API or documented upload format was found. Open Gallery keeps Artnet listing links and does not produce an "Artnet" file.

## Reference projects for install, backup and upgrade

- **Mike** (github.com/open-legal-products/mike, AGPL-3.0): Docker Compose quick start; separate production guide; all model keys optional; Ollama as an OpenAI-compatible local option; dated migrations with "back up the database first". Borrowed: optional providers off by default, automatic numbered migrations, back-up-before-upgrade guidance. Not borrowed: Docker, Supabase and object storage (too much to operate for one gallery workstation), default-on telemetry.
- **Paperless-ngx**: `document_exporter` writes files plus `manifest.json`; `document_importer` requires a completely empty installation. Borrowed: manifest with checksums, restore only into empty workspace.
- **Immich**: database dumps alone are not a backup; the originals folder must be backed up too. Borrowed: one export containing both records and originals.
- **Nextcloud**: back up config, data, theme and database; no downgrades, restore into a fresh install instead. Borrowed: customization kept in the data folder and included in exports; refuse to open a newer-schema workspace.

## License

AGPL-3.0 chosen for the application, consistent with Mike, Immich, Paperless-ngx (GPL) and Nextcloud. It lets anyone run and change the software and requires a hosted modified version to share its source, which protects galleries from a closed hosted fork. It covers the code only, never gallery content. This is a reasoned choice, not legal advice.
