#!/usr/bin/env node
// Open Gallery command line. Everyday use happens in the browser; these commands exist for
// installation, scripting and recovery.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
const { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, accessSync, constants } = await import('node:fs');
const store = await import('../lib/store.mjs');
const { join, resolve, basename } = await import('node:path');
const { homedir } = await import('node:os');
const { createApp } = await import('../server.mjs');
const { openWorkspace, isEmptyWorkspace } = await import('../lib/db.mjs');
const { exportBundle, restoreBundle, verifyWorkspace } = await import('../lib/backup.mjs');
const { buildSite } = await import('../lib/site.mjs');
const { seedDemo } = await import('../lib/demo-seed.mjs');
const awaitSettings = await import('../lib/settings.mjs');
const { uploadImport, previewImport, applyImport, importImages } = await import('../lib/importer.mjs');

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; } else args.push(rest[i]);
}
// The workspace folder: --data, then OPEN_GALLERY_DATA, then the last folder used, then ~/Open Gallery.
const CONFIG = join(homedir(), '.config', 'open-gallery', 'config.json');
let remembered = null;
try { remembered = JSON.parse(readFileSync(CONFIG, 'utf8')).dataDir || null; } catch {}
const dataDir = resolve(String(flags.data || process.env.OPEN_GALLERY_DATA || remembered || join(homedir(), 'Open Gallery')));
function rememberDataDir() {
  if (!flags.data) return;
  try { mkdirSync(join(CONFIG, '..'), { recursive: true }); writeFileSync(CONFIG, JSON.stringify({ dataDir }, null, 2)); } catch {}
}
const port = Number(flags.port || process.env.OPEN_GALLERY_PORT || process.env.PORT || 4380);

function start() {
  rememberDataDir();
  const app = createApp({ dataDir });
  app.server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Open Gallery may already be running: try http://localhost:${port}\nOr start on another port: open-gallery start --port ${port + 1}`);
    else console.error(e.message);
    process.exit(1);
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Open Gallery is running at http://localhost:${port}\nWorkspace: ${dataDir}\nOnly this computer can open it. Press Ctrl+C to stop.`);
    if (flags.open) import('node:child_process').then(({ spawn }) => spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [`http://localhost:${port}`], { stdio: 'ignore', detached: true }).unref());
  });
  const stop = () => { app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

const commands = {
  start,
  async host() {
    // Many galleries on one server. Put it behind HTTPS (for example a Cloudflare Tunnel).
    const { createHosted } = await import('../lib/hosted.mjs');
    const root = resolve(String(flags.root || join(homedir(), 'Open Gallery Hosted')));
    const origin = String(flags.origin || `http://localhost:${port}`).replace(/\/$/, '');
    const hosts = String(flags.host || '').split(',').filter(Boolean);
    const h = createHosted({ root, publicOrigin: origin, quotaBytes: Number(flags.quota || 2e9), secureCookies: origin.startsWith('https://'), allowedHosts: hosts });
    h.server.listen(port, String(flags.bind || '127.0.0.1'), () => console.log(`Open Gallery hosted mode at ${origin} (listening on ${port})\nData: ${root}`));
    const stop = () => { h.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  },
  demo() {
    rememberDataDir();
    if (!isEmptyWorkspace(dataDir)) { console.log(`Workspace ${dataDir} already has data; demo data was not added.`); return flags['no-start'] ? undefined : start(); }
    const db = openWorkspace(dataDir);
    const t = Date.now();
    const r = seedDemo(db, dataDir);
    db.close();
    console.log(`Demo gallery created in ${((Date.now() - t) / 1000).toFixed(1)}s: ${r.import.created} works, ${r.images.matched} images, ${r.published} published, 1 exhibition.`);
    if (!flags['no-start']) start();
  },
  import() {
    const file = args[0];
    if (!file) throw new Error('Usage: open-gallery import <spreadsheet.csv|.xlsx> [--images <folder>] [--apply]');
    const db = openWorkspace(dataDir);
    const up = uploadImport(db, dataDir, basename(file), readFileSync(file));
    const pv = previewImport(db, dataDir, up.id);
    console.log(JSON.stringify({ import: up.id, mapping: Object.fromEntries(up.headers.map((h, i) => [h, up.mapping[i]])), summary: pv.summary }, null, 2));
    const attention = pv.plan.filter((p) => p.action === 'error' || p.action === 'review' || p.changes.some((c) => c.kind !== 'update'));
    if (attention.length) {
      console.log('\nRows that need a person:');
      for (const p of attention) {
        const why = [...p.issues.filter((i) => i.level === 'error').map((i) => i.message),
          ...(p.action === 'review' ? [p.duplicateOf?.length ? `possible duplicate of ${p.duplicateOf.map((d) => d.stock || d.title).join(' or ')}` : `same artist and title as row ${p.duplicateInFile}`] : []),
          ...p.changes.filter((c) => c.kind !== 'update').map((c) => c.message)];
        console.log(`  row ${p.row} ${p.stock || ''} ${p.artist}, "${p.title || '(no title)'}": ${why.join('; ')}`);
      }
    }
    let applied = false;
    if (flags.apply) {
      if (pv.summary.review) { console.log(`\n${pv.summary.review} possible duplicate(s) need a person's decision. Nothing was applied. Open the app: Import > ${up.filename}.`); }
      else { console.log('Applied:', JSON.stringify(applyImport(db, dataDir, up.id))); applied = true; }
    } else console.log('\nPreview only. Your catalog is unchanged (a copy of the file is kept with the import history). Add --apply to apply, or review it in the app.');
    if (flags.images && !applied) console.log('Images were not imported because the spreadsheet was not applied. They are matched to works by inventory number, so import them after applying.');
    if (flags.images && applied) {
      const dir = String(flags.images);
      const files = readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).map((name) => ({ name, buf: readFileSync(join(dir, name)) }));
      const r = importImages(db, dataDir, files);
      console.log(`Images: ${r.matched} matched, ${r.duplicates} already present, ${r.unmatched} unmatched (assign them in the app), ${r.errors} errors.`);
    }
    db.close();
  },
  export() {
    const db = openWorkspace(dataDir);
    const { zip, manifest } = exportBundle(db, dataDir);
    const out = resolve(String(flags.out || `open-gallery-export-${manifest.created_at.slice(0, 10)}.zip`));
    writeFileSync(out, zip);
    db.close();
    console.log(`Exported ${manifest.counts.artworks} works, ${manifest.counts.media} images, ${manifest.files.length} files (${(zip.length / 1e6).toFixed(1)} MB) to ${out}`);
  },
  restore() {
    if (!args[0]) throw new Error('Usage: open-gallery restore <export.zip> --data <empty folder>');
    const r = restoreBundle(readFileSync(args[0]), dataDir);
    console.log(JSON.stringify({ ok: r.ok, counts: r.counts, problems: r.verify.problems, mismatched: r.mismatched }, null, 2));
    if (!r.ok) process.exit(2);
  },
  'build-site'() {
    const db = openWorkspace(dataDir);
    const out = resolve(String(flags.out || join(dataDir, 'site')));
    const r = buildSite(db, dataDir, out);
    db.close();
    console.log(JSON.stringify(r, null, 2));
  },
  verify() {
    const db = openWorkspace(dataDir);
    const r = verifyWorkspace(db, dataDir);
    db.close();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(2);
  },
  settings() {
    // For assistants and scripts: change presentation without editing code.
    const { getSettings, updateSettings } = awaitSettings;
    const db = openWorkspace(dataDir);
    if (args[0] === 'set') {
      const [, key, ...val] = args;
      let v = val.join(' ');
      if (v === 'true' || v === 'false') v = v === 'true'; else if (/^\d+$/.test(v) && key === 'theme.corner') v = Number(v);
      const r = updateSettings(db, { [key]: v });
      if (Object.keys(r.errors).length) { console.error(JSON.stringify(r.errors)); process.exit(1); }
      console.log(`${key} = ${JSON.stringify(v)}`);
    } else console.log(JSON.stringify(getSettings(db), null, 2));
    db.close();
  },
  doctor() {
    const [maj, min] = process.versions.node.split('.').map(Number);
    const ok = maj > 22 || (maj === 22 && min >= 13);
    console.log(`Node.js ${process.versions.node}: ${ok ? 'OK' : 'too old; install Node.js 22.13 or newer from https://nodejs.org'}`);
    // Check without creating anything: the folder itself if it exists, otherwise its nearest existing parent.
    let probe = dataDir;
    while (!existsSync(probe) && probe !== resolve(probe, '..')) probe = resolve(probe, '..');
    try { accessSync(probe, constants.W_OK); console.log(`Workspace folder ${dataDir}: ${existsSync(dataDir) ? 'exists and is writable' : 'can be created'}`); } catch { console.log(`Workspace folder ${dataDir}: NOT writable. Choose another with --data FOLDER.`); }
    if (!ok) process.exit(1);
  },
  'publish-works'() {
    // Mark works public by filter: --availability available | --all | inventory numbers as arguments.
    const db = openWorkspace(dataDir);
    let ids;
    if (args.length) ids = args.map((s) => db.prepare('SELECT id FROM artworks WHERE stock_number = ? COLLATE NOCASE').get(s)?.id).filter(Boolean);
    else if (flags.all) ids = db.prepare('SELECT id FROM artworks').all().map((r) => r.id);
    else if (flags.availability) ids = db.prepare('SELECT id FROM artworks WHERE availability=?').all(String(flags.availability)).map((r) => r.id);
    else throw new Error('Usage: open-gallery publish-works [INVENTORY_NO ...] | --availability available | --all  [--private to unpublish]');
    for (const id of ids) store.updateArtwork(db, id, { public: !flags.private });
    db.close();
    console.log(`${flags.private ? 'Made private' : 'Published'}: ${ids.length} work(s). Run build-site to update the public catalog.`);
  },
  exhibition() {
    // open-gallery exhibition "Title" --works GL-1,GL-2 [--dates "..."] [--subtitle "..."] [--publish]
    const title = args[0];
    if (!title) throw new Error('Usage: open-gallery exhibition "Title" --works INV1,INV2,... [--subtitle TEXT] [--dates TEXT] [--intro TEXT] [--layout grid|list|salon] [--publish]');
    const db = openWorkspace(dataDir);
    const nums = String(flags.works || '').split(',').map((s) => s.trim()).filter(Boolean);
    const items = nums.map((s) => db.prepare('SELECT id FROM artworks WHERE stock_number = ? COLLATE NOCASE').get(s)?.id);
    const missing = nums.filter((_, i) => !items[i]);
    if (missing.length) throw new Error(`No work with inventory number: ${missing.join(', ')}`);
    const ex = store.saveExhibition(db, null, { title, subtitle: flags.subtitle, dates: flags.dates, intro: flags.intro, layout: flags.layout, published: !!flags.publish, items });
    db.close();
    console.log(`Exhibition "${ex.title}" created with ${ex.items.length} work(s)${ex.published ? ', included on the public site' : ' (draft)'}.\nPrintable catalog while the app is running: http://localhost:${port}/print/exhibitions/${ex.id}`);
  },
  help() {
    console.log(`Open Gallery ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version}

  open-gallery demo                 Create a fictional sample gallery and open the app
  open-gallery start [--open]       Open your gallery workspace
  open-gallery import FILE [--images DIR] [--apply]
  open-gallery export [--out FILE]  Save a complete backup (.zip)
  open-gallery restore FILE --data EMPTY_FOLDER
  open-gallery build-site [--out DIR]   Make the public website from published works
  open-gallery publish-works [INV ...] | --availability available | --all [--private]
  open-gallery exhibition "Title" --works INV1,INV2 [--dates TEXT] [--publish]
  open-gallery settings [set KEY VALUE]  Show or change settings (e.g. theme.colorAccent #224466)
  open-gallery verify               Check every image and relationship
  open-gallery doctor               Check this computer is ready
  open-gallery host --root DIR --origin https://… --host name   Run the multi-gallery hosted version

Options: --data FOLDER (remembered after start or demo; default ~/Open Gallery), --port N (default 4380)`);
  },
};
try {
  if (!commands[cmd]) { console.error(`Unknown command "${cmd}".`); commands.help(); process.exit(1); }
  await commands[cmd]();
} catch (e) { console.error(e.message); process.exit(1); }
