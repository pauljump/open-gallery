# Open catalog feed: `open-gallery-catalog/0.1`

Every public build writes `catalog.json` next to the HTML pages. It contains only works and fields the gallery chose to publish. It is meant for the gallery's own use (another website, a fair app, a future shared index) and for anyone the gallery chooses to share it with.

**Draft.** Field names may change before 1.0; the `format` string will change when they do.

```json
{
  "format": "open-gallery-catalog/0.1",
  "generated_at": "2026-10-16T15:53:29.011Z",
  "generator": "Open Gallery",
  "publisher": { "name": "…", "website": "https://…", "email": "…" },
  "rights": { "statement": "…", "note": "Artwork copyright remains with the artists or other rights holders. Inclusion in this feed is not a license to reproduce images." },
  "availability_as_of": "2026-10-16T15:53:29.011Z",
  "works": [ { …work… } ],
  "exhibitions": [ { "id", "slug", "title", "subtitle", "dates", "url", "works": ["aw_…"] } ],
  "withdrawn": [ { "id": "aw_…", "withdrawn_at": "…" } ]
}
```

## Work

| Field | Meaning |
|---|---|
| `id` | Stable Open Gallery identifier. Survives edits, re-imports, export and restore. |
| `slug`, `url` | Public page. `url` is absolute when the gallery sets its public address. |
| `stock_number` | The gallery's inventory number, only if the gallery chose to show it; otherwise `null`. |
| `artist` | `{ id, name }` |
| `title`, `year`, `medium`, `category`, `edition` | As catalogued. |
| `dimensions` | List of `{ kind: "work"|"framed", h, w, d, diameter, unit: "in"|"cm"|"mm" }`. |
| `dimensions_display` | Human-readable strings with converted units. |
| `availability` | `available`, `on_hold`, `sold`, `nfs`, `on_loan`, or `null` when unknown. As of `availability_as_of`; not live. |
| `price` | `{ amount, max?, currency, display }` only when the gallery shows the price and the work is available; `{ display: "Price on request" }`; or `null`. |
| `signature`, `provenance`, `exhibition_history`, `literature`, `description`, `image_credit` | Public text as entered. |
| `custom` | Gallery-defined fields the gallery marked as publishable, keyed by label. |
| `images` | `{ url, sha256_original, width, height, caption }`. `sha256_original` identifies the original file in the gallery's private archive; the published file is usually a smaller web copy. |
| `links` | Existing listings: `{ channel, url }` (a marketplace or the gallery website). Purchases there follow that site's terms. |
| `updated_at`, `first_published_at` | Timestamps. |

## Withdrawal and corrections

When a gallery unpublishes a work, the next build removes it from `works` and lists its `id` under `withdrawn` with a timestamp. Anyone aggregating feeds should delete withdrawn works. Copies already downloaded by others cannot be recalled; galleries should publish only what they are comfortable sharing.

Corrections are simply the next build: same `id`, new values, new `updated_at`.

## Never included

Location, acquisition cost, consignor, consignment terms, insurance value, buyer, private notes, unmapped spreadsheet columns, private custom fields, import history and the change log. This is enforced by a single allowlist (`publicArtwork` in `lib/site.mjs`) and tested by scanning every built file for seeded private values.
