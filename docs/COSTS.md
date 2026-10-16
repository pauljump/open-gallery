# What Open Gallery costs

**The software is free.** No license fee, subscription, commission, per-work charge or feature unlock, and no paid AI call in any core task. That stays true if this project stops: the code, the formats and the instructions are all in the repository.

Real costs that remain, and what they look like:

| Item | Needed? | Typical cost | Notes |
|---|---|---|---|
| A computer | Yes | One you already have | Mac, Windows or Linux with Node.js 22.13+. The sample gallery uses about 17 MB; your images decide the real size. |
| Storage for originals | Yes | Your existing disk | High-resolution originals are usually the largest part. Keep the export on a second drive or cloud folder you already pay for. |
| Hosting the public catalog | Optional | $0 on a free static host, or your existing web host | Free tiers (Cloudflare Pages, Netlify, GitHub Pages) have their own terms and limits. Prices current at time of writing should be checked on the host's own page. |
| A domain | Optional | Roughly $10–20 per year from a registrar | You can also use a sub-folder of your current website. |
| Email | Optional | Your existing address | Inquiry buttons open a draft to it. No email service is involved. |
| AI assistance | Optional | Your own Claude or Codex plan, if you use one to install or customize | Not needed for daily use. Open Gallery does not call any AI service. |
| Electricity | Yes | Negligible | The app only runs while you have it open. |
| Support | Optional | None offered yet | Community support only, for now. |

**What a local install does not give you:** an always-online website or anything that runs while the computer is asleep. The public catalog is separate: once uploaded to a host, it stays online whether your computer is on or not, and shows availability as of your last build.

**Measured for this release:** creating the sample gallery takes about 2 seconds on an Apple Silicon Mac mini; its full export is 16.5 MB. See [VERIFICATION.md](VERIFICATION.md).
