# Verification results

## Release 0.2.0: operations layer

Measured 2026-10-16, same machine and synthetic data. `npm test`: 34 tests, 34 passing.

- **Money math** (`test/ledger.test.mjs`): consignor share for discounts shared pro rata, absorbed by the gallery, or absorbed by the consignor, in integer cents; deductions; gallery-owned sales owe nothing.
- **Rules**: one active consignment per work; discount over the agreed limit needs approval; holds queue, expire and drive availability; a sale converts the buyer's hold and releases others; payouts only cover that payee's fully paid sales and the exact amount; paid-out sales cannot be repriced or cancelled.
- **Privacy**: buyer and consignor names, emails, notes, invoice numbers, sale prices and deductions scanned across every built public file: none found. Sold works show "sold" with no price.
- **Restore and upgrade**: every operations table restores row for row and statements match. A 0.1.0 workspace upgrades in place and records sales, and a 0.1.0 export restores into 0.2.0 (this test found and fixed a bug that marked old exports as mismatched).
- **Browser run**: consignment, hold, discounted sale with deposit, deduction, final payment, payout from Money, and the artist statement, with no page errors; Money, Contacts, statement and work pages at 390 px with no horizontal scroll; labels and ids checked on the new pages.

Not verified: any real gallery's consignment terms or books; tax treatment; multi-currency totals (amounts in different currencies are added without conversion).

## Release 0.1.0

Measured 2026-10-16 on an Apple M4 Mac mini, macOS, Node.js 22.22.2, using synthetic data only (a fictional 60-work gallery with generated CC0 images, and a 1,500-work fixture). **No real gallery data and no real gallery owner were involved.**

## Automated suite: `npm test`

26 tests, 26 passing, about 8 seconds.

| Area | What is asserted |
|---|---|
| Import (`test/import.test.mjs`) | CSV and XLSX of the same sheet produce identical catalogs; column suggestions; unknown columns kept; original file stored byte for byte; missing title refused; POA, comma prices, centimetres, messy status text parsed; repeat import of the same file changes nothing; week-later sheet: price changes and new sales applied, stale "available" for a sold work held as sold, near-duplicate blocks apply until decided (skip, add, or merge keeping the catalog's inventory number), removed work flagged not deleted, dropped column keeps old values, new column kept |
| Customization | Staff edits, publication choices, exhibition membership, theme and custom CSS survive re-import; sheet-and-staff conflicts default to the staff value and can take the sheet value; the same sheet does not re-ask |
| Privacy (`test/privacy.test.mjs`) | Every built file (HTML, JSON, CSS, text) scanned for every seeded cost, insurance value, consignor, note, location and unmapped-column value: none found. Unpublished works, private custom fields, hidden prices and exhibition-level price hiding verified. Withdrawn works listed in the feed |
| Backup (`test/backup.test.mjs`) | Export then restore into an empty folder: equal row counts in every table, equal artwork records, every original image checksum, exhibitions, settings, custom CSS and import files. Restore into a non-empty workspace refused. A single flipped byte in an image refuses the restore and leaves the target empty. A missing or damaged original stops export with a clear message |
| Artsy file (`test/artsy.test.mjs`) | 150 eligible works produce 2 files of at most 100 rows with images; sold, priceless, yearless, edition and already-listed works skipped with reasons; connector state is "file exchange", never "connected"; README says nothing was sent |
| Engine (`test/engine.test.mjs`) | Demo works offline with no key; reopening keeps data; a newer-schema workspace refuses to open and stays intact; a failure in the middle of applying an import leaves no partial changes |
| Server (`test/server.test.mjs`) | Requests without the app header are refused; foreign Host headers refused; path traversal cannot reach the database |

## Performance (1,500 works, no images)

Upload 9 ms, preview 38 ms, apply 560 ms, repeat preview 605 ms, search 2 to 3 ms, list 9 ms. The brief's target of a useful 100-work preview within 15 minutes is met by the software; the human time to prepare a real gallery's files has not been measured.

## Browser checks (headless Google Chrome 155 driven by Playwright)

- **Fresh install journey, scripted through the real UI**: empty workspace → import XLSX (1 in-file duplicate decided) → 59 works → 75 images uploaded and 69 matched in 1.1 s → settings changed → all works published → new exhibition with 4 works → public catalog built with 69 web-sized JPEG copies (4.0 MB versus 16 MB of originals) → export downloaded → restored through the browser into a second empty instance: "Restored 59 works and 75 images. Every checksum matched." No page errors.
- **Re-import journey**: week-later sheet, Apply disabled until the duplicate was decided, applied in 0.6 s.
- **Layouts**: 8 app views and 4 public pages at 1280 px and 390 px wide, no horizontal scrolling.
- **Keyboard**: `/` focuses search; Tab reaches a work and Enter opens it; focus moves to the page heading on navigation; visible focus outlines.
- **Basic accessibility scan** on 10 app views and 3 public pages: every form control labelled, every image has alt text, no empty buttons or links, one h1 per page, no duplicate ids (one duplicate-id issue found on the Artists page and fixed).
- Settings page computes text contrast and warns below 4.5:1. Default themes: app text about 16:1, secondary text about 5.9:1; public site secondary text about 5.4:1.

## Assistant install journey (Claude)

A separate Claude agent played the assistant for a fictional owner ("Lantern Street Gallery"), following only README, AGENTS.md, INSTALL-PROMPT and OPERATING: doctor, clone, preview, apply (1 row without a title skipped), images, warm serif style through `settings set`, 30 works published, a 6-work exhibition, public build, printable catalog, export (10.2 MB) and a successful test restore, in about 2 minutes of commands. Nothing public or paid happened.

It found six problems, all fixed and re-checked before tagging 0.1.0: the command-line preview stored images as unmatched copies (now images import only after apply, and a later match absorbs an earlier unmatched copy; test added); `doctor` created the data folder (now it creates nothing); the preview did not say which rows needed attention (now listed); publishing works and creating exhibitions had no documented command (`publish-works`, `exhibition` added); `--data` had to be repeated (now remembered after `start` or `demo`); the bare `open-gallery` command needed explanation (documented, with `npm link` as an option).

## Upgrade and rollback

A workspace created by the first engine commit (`16a2afe`), with a changed accent colour and a custom CSS file, opened in the current code with data verified, settings and CSS intact and included in the rebuilt site. The older code still opened it afterwards (same schema). A future schema change will be refused by older versions by design (tested).

## Not verified

- A real gallery owner completing the workflow, or real gallery spreadsheets.
- Screen reader use (VoiceOver, NVDA). Only automated checks were run.
- The Codex install journey, and any assistant journey run by a real owner.
- Windows and Linux. Only macOS was tested.
- Opening the generated XLSX in Excel or Numbers, and uploading the Artsy file to a real Artsy account.
- Removal of camera metadata from public JPEGs (images are re-encoded through the browser canvas, which does not copy metadata, but this was not tested with a real photo).
- Very large archives (bundles over 4 GB are not supported yet).
