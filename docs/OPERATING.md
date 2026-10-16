# Operating guide

## Daily use

Commands are shown as `open-gallery …`. Run them from the app folder as `node bin/open-gallery.mjs …`, or run `npm link` once in that folder so the short form works everywhere.


Start: `open-gallery start --open` (or `node bin/open-gallery.mjs start --open` from the app folder). The app opens at http://localhost:4380 and only this computer can reach it. Stop it with Ctrl+C or by closing the terminal. Nothing runs in the background when it is stopped.

- **Works**: search (press `/`), filter by artist, availability, published or private. Select several works to publish, make private or change availability at once.
- **A work**: edit any field, add or reorder images, choose which images are public. The right-hand panel shows exactly what the public will see.
- **Exhibitions**: create one, add works, reorder, write the introduction, choose a layout. **Printable catalog** opens a page you print or save as PDF.
- **Import**: bring in a newer copy of your spreadsheet whenever you like. Review, then apply.
- **Publish**: build the public catalog folder, preview it, and prepare Artsy upload files.
- **Backup**: download a full export, check the workspace, or restore into an empty workspace.

## Consignments, holds, sales and payouts

On a work's page, **Ownership and sales** records who owns the work:

- **Record consignment**: from the artist or from a collector or another gallery, with the consignor's share, how much discount you may give without asking, who absorbs a discount (shared, the gallery, or the consignor), dates and insurance. An artist's usual share can be set on the Artists page.
- **Holds**: place a hold for a client with an expiry (48 hours by default). Several holds queue in order. The work shows as reserved while any hold is active and returns to available when they lapse.
- **Record a sale**: buyer, price, tax, shipping, deposit and invoice number. A discount beyond the consignment's limit asks for the consignor's approval. Record later payments and deductions (framing, shipping charged back) on the same card. Cancelling a sale makes the work available again.

**Money** shows, per artist or consignor, what is waiting on the buyer, what is owed and when it is due (30 days after the buyer pays in full, adjustable in settings), and what is overdue. Record a payout against specific sales. **Statement** prints a period statement for an artist or consignor, ready to save as PDF and send. **Download accounting CSV** gives your bookkeeper every sale and payout.

None of this ever appears on the public site.

## Re-importing a newer spreadsheet

Your spreadsheet can stay your main record while you try Open Gallery. Each re-import:

- updates fields that changed in the sheet;
- keeps edits you made in Open Gallery unless the sheet also changed that field, in which case it asks;
- keeps sold works sold, even if an older copy of the sheet says available, unless you choose otherwise for that work;
- asks about rows that look like a work you already have under a different inventory number;
- flags works that are no longer in the sheet and never deletes them;
- never touches exhibitions, publication choices, image order or visual settings.

## Updating Open Gallery

Your data folder is separate from the app, so an update cannot erase it.

1. Download an export first (Backup > Download export).
2. Stop the app.
3. Get the new version (`git pull` in the app folder, or ask your assistant to "update Open Gallery").
4. Start it. Database changes are applied automatically, in one step that either completes or leaves the old data untouched.

If something is wrong, go back to the previous version (`git checkout <previous tag>`) and start it again. A workspace already upgraded by a newer version will refuse to open in an older one rather than risk damage; in that case restore your pre-update export into a new folder with the older version.

## Backups

- **Export** (Backup > Download export, or `open-gallery export`): one ZIP with everything, checked by checksums. Keep copies off this computer.
- **Folder copy**: with the app stopped, copying the data folder is also complete.
- **Restore**: `open-gallery restore export.zip --data "~/Open Gallery Restored"` or start the app on an empty folder and use Backup > Restore. Restore never overwrites an existing workspace.
- **Check**: Backup > Run check (or `open-gallery verify`) confirms every image file is present and undamaged.

## Putting the public catalog online

Publish > Build creates a folder (inside your data folder, `site/`). It is plain HTML, images and `catalog.json`. Upload it to any static host, or to a sub-folder of your existing site. Rebuild and upload again when availability changes; every page says the date it reflects.

Inquiry buttons open an email draft addressed to your inquiry email. Nothing is stored or sent by Open Gallery, and you will only know about an inquiry when the visitor sends that email.

## Troubleshooting

| Problem | What to do |
|---|---|
| "Port 4380 is already in use" | Open Gallery is probably already running: open http://localhost:4380. Or start with `--port 4381`. |
| Node.js too old | Install the current LTS from nodejs.org, then run `open-gallery doctor`. |
| .xls or Numbers file refused | Save or export it as .xlsx or CSV first. |
| Images not matched | Name files by inventory number, or assign them in Import > Images not matched. |
| A column went to the wrong field | Re-upload the sheet; the mapping table lets you change it before applying. Your choice is remembered next time. |
| Export stopped with "image is missing/damaged" | Run Backup > Run check. Restore the missing originals from an earlier export or your image folder, then export again. |
| Restore refused | Restore only runs into an empty folder. Use a new `--data` folder. |
