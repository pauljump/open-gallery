# Open Gallery

Free, open source inventory and catalog software for galleries. It runs on your own computer, works from a copy of the spreadsheet and images you already have, and leaves your marketplace listings, your website and your sales process exactly as they are.

**Keep your marketplaces. Own your catalog.**

What it does today (version 0.3):

- **Import a copy of your inventory** from CSV or Excel. You see every column mapping and every change before anything is saved. Columns it does not understand are kept, not dropped. The original file is stored unchanged.
- **Re-import safely.** A later spreadsheet updates prices and status, but never overwrites an edit you made in the app without asking, never marks a sold work available again on its own, and never deletes works that are missing from the file.
- **Find works fast**: filter by artist, availability, price range and the width of the wall (any unit), sort by price, year or recent changes. Reprice a selection by a percentage, an amount or a set price with a preview and one-click undo, and add a selection to an exhibition.
- **Edit works**: artists, dimensions (work and framed, inches or centimetres), prices, availability, location, private notes, your own custom fields, and images matched by file name.
- **Track who owns each work and what you owe.** Record consignments from artists or collectors (split, discount limit, who absorbs a discount, dates, insurance), holds with expiry and a queue, and sales with deposits, payments, tax and deductions. Open Gallery works out what each artist or consignor is owed and when it is due, shows what is overdue, records payouts, and prints a clear statement for each artist. An accounting CSV goes to your bookkeeper. All of it is private.
- **Build exhibitions** with your order, text and layout, plus a printable catalog you can save as a PDF.
- **Publish a public catalog** made only from works and fields you approve. Location, costs, consignors, buyers, notes and unmapped columns are never written to public files. Existing marketplace and website listing links stay on each work.
- **Export everything** to one ZIP: original images, every record and relationship, settings, custom styles, your original import files, and plain spreadsheets. **Restore** it into a fresh installation, with every file checked against its checksum.
- **Prepare a marketplace bulk-import file** for new works you choose, and a checklist for works already listed. Open Gallery has no access to your marketplace accounts; nothing is sent anywhere.

No account, subscription, commission or AI service is needed for any of this.

## Hosted or on your own computer

The same software runs in two ways:

- **On your own computer** (below): your data never leaves it.
- **Hosted**: `open-gallery host --root DIR --origin https://your.domain --host your.domain` runs many galleries on one server, each in its own workspace with its own database and images. Galleries sign up with an email and password, and each one's public catalog is served at `/g/<name>/` after it chooses to publish. Put it behind HTTPS. Each workspace has a storage limit (2 GB by default) and can be exported or deleted by its owner at any time. `open-gallery host-backup --root DIR --out BACKUP_DIR` writes a verified export of every gallery plus the account list, keeping 14 days; run it nightly.

Published catalogs on the hosted version include structured data and share previews for each work, a sitemap, and an inquiry form that delivers messages straight into the gallery's workspace.

## Importing from what you already have

- **Spreadsheets** from any system: columns are matched automatically, including exports from common gallery systems and marketplace bulk-import sheets. A unit column (in/cm) and an image file names column are understood.
- **Image links**: if your spreadsheet has image web addresses, Open Gallery downloads them after the import.
- **Your own website**: give the address of your gallery's site. Open Gallery reads its public pages (respecting robots.txt), finds artwork pages from structured data or page layout, and turns them into a spreadsheet you review before anything is saved.

## Try it

You need [Node.js](https://nodejs.org) 22.13 or newer.

```sh
git clone https://github.com/pauljump/open-gallery.git
cd open-gallery
node bin/open-gallery.mjs demo --open
```

That creates a fictional sample gallery (60 invented works with generated images) in `~/Open Gallery` and opens the app at http://localhost:4380. To start with your own files instead, run `node bin/open-gallery.mjs start --open` and choose **Import**.

Or ask Claude or Codex to set it up for you with the prompt in [docs/INSTALL-PROMPT.md](docs/INSTALL-PROMPT.md).

## Where your data lives

Everything is in one folder you choose (default `~/Open Gallery`): a SQLite database, your original images, your import files and your customizations. The application code lives somewhere else, so updating or reinstalling the app never touches your data. Copying that folder while the app is stopped is a complete backup; **Backup > Download export** makes a portable one.

## What it is not (yet)

- Not a live sync with any marketplace. There is no approved API access. Listing links are kept, and upload files are prepared for you to upload yourself.
- Not a shop. Public pages offer an email draft to the gallery and links to your existing listings. There is no checkout, so a work cannot be sold twice through Open Gallery.
- Not a multi-user server. It is built and tested for one computer. A shared office setup needs authentication that is not built yet.
- Not hosting. The public catalog is a folder of files you upload to a host of your choice. See [docs/COSTS.md](docs/COSTS.md).
- Not tested yet by a real gallery owner. See [docs/CLAIMS.md](docs/CLAIMS.md) for what has and has not been verified.

## Documentation

- [Operating guide](docs/OPERATING.md): daily use, updates, backups, troubleshooting
- [Install prompt for Claude or Codex](docs/INSTALL-PROMPT.md)
- [Costs](docs/COSTS.md): what is free and what is not
- [Claims ledger](docs/CLAIMS.md): every public promise and its evidence
- [Open catalog format](docs/CATALOG-FORMAT.md) and [export bundle format](docs/BUNDLE-FORMAT.md)
- [Verification results](docs/VERIFICATION.md)
- [For developers and assistants](AGENTS.md)

## License

The application code is licensed under the [GNU AGPL-3.0](LICENSE). You can run, study, change and share it. If you run a modified version as a service for others, you must offer them your source. This license covers the software only. Your artwork images, catalog text and records remain yours and your artists'; the license gives nobody, including this project, any rights to them.
