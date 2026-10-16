# Claims ledger

Every public promise Open Gallery makes, and what supports it. If a claim has no evidence, it is not made.

| Claim | Status | Evidence or qualification |
|---|---|---|
| Free: no fee, subscription, commission or required paid AI call | True | AGPL-3.0; no network or AI calls in the code (no runtime dependencies at all). Hosting, domains and storage are real costs, see COSTS.md |
| Runs without an account or API key | Verified | `engine.test.mjs` demo test; fresh-install browser journey |
| Imports from a copy and keeps the original file and unknown columns | Verified | `import.test.mjs` |
| Re-import never silently overwrites staff edits, un-sells sold works, or deletes missing works | Verified | `import.test.mjs`, re-import browser journey |
| Duplicates need a human decision | Verified | `import.test.mjs` (409 until decided) |
| Private fields never appear in public output | Verified on synthetic data | `privacy.test.mjs` scans every built file for seeded values |
| Complete export and restore into a fresh install | Verified on synthetic data | `backup.test.mjs`, browser restore journey; bundles over 4 GB not supported |
| Customization survives updates | Verified for one simulated update | VERIFICATION.md "Upgrade and rollback"; settings and CSS live in the data folder |
| Keeps working if the project disappears | By design | Local app, no service of ours involved, documented formats; not something a test can prove |
| Existing Artsy and Artnet links stay available | Verified | Links imported and shown on public pages; nothing written to those services |
| Artsy bulk-import file | Built from public notes; **not tested with a real Artsy account** | RESEARCH-NOTES.md; the current CMS template was not visible without a partner login |
| Artsy or Artnet integration or sync | **Not claimed** | No authorized access exists. Connector state shows "not connected" or "file exchange" |
| Usable by a non-technical owner | **Not claimed yet** | No owner has completed the workflow |
| One prompt installs it with Claude or Codex | **Partly verified** | Repository public; a fresh GitHub clone runs the demo and passes all tests; a Claude agent completed the documented journey after fixes (VERIFICATION.md); Codex not tested; no real owner yet |
| Production hosting | **Not claimed** | Local workstation app; the public catalog is static files for a host the gallery chooses |
| Phone and desktop layouts, keyboard use | Verified with automated checks | VERIFICATION.md; screen readers not tested |

## Language rules for public copy

- Do not say Artsy or Artnet "own" a gallery's artwork. Artsy's terms let users keep their rights while granting Artsy a broad license.
- Do not call file exchange an integration, sync or connection.
- Distinguish artwork copyright, image licenses, catalog database, software and private customer records.
- Proposed slogans ("Your gallery. Your files. Your choice." / "Keep your marketplaces. Own your catalog." / "Free to run. Free to change. Free to leave.") are used only where the row above supports them.
