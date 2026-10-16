#!/usr/bin/env node
// Open Gallery command line. Everyday use happens in the browser; these commands exist for
// installation, scripting and recovery.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
const { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } = await import('node:fs');
const { join, resolve, basename } = await import('node:path');
const { homedir } = await import('node:os');
const { createApp } = await import('../server.mjs');
const { openWorkspace, isEmptyWorkspace } = await import('../lib/db.mjs');
const { exportBundle, restoreBundle, verifyWorkspace } = await import('../lib/backup.mjs');
const { buildSite } = await import('../lib/site.mjs');
const { seedDemo } = await import('../lib/demo-seed.mjs');
const { uploadImport, previewImport, applyImport, importImages } = await import('../lib/importer.mjs');

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; } else args.push(rest[i]);
}
const dataDir = resolve(String(flags.data || process.env.OPEN_GALLERY_DATA || join(homedir(), 'Open Gallery')));
const port = Number(flags.port || process.env.OPEN_GALLERY_PORT || 4380);

function start() {
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
  demo() {
    if (!isEmptyWorkspace(dataDir)) { console.log(`Workspace ${dataDir} already has data; starting it without adding demo data.`); return start(); }
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
    if (flags.apply) {
      if (pv.summary.review) { console.log(`\n${pv.summary.review} possible duplicate(s) need a person's decision. Open the app: Import > ${up.filename}.`); }
      else console.log('Applied:', JSON.stringify(applyImport(db, dataDir, up.id)));
    } else console.log('\nPreview only. Nothing changed. Add --apply to apply, or review it in the app.');
    if (flags.images) {
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
  doctor() {
    const [maj, min] = process.versions.node.split('.').map(Number);
    const ok = maj > 22 || (maj === 22 && min >= 13);
    console.log(`Node.js ${process.versions.node}: ${ok ? 'OK' : 'too old; install Node.js 22.13 or newer from https://nodejs.org'}`);
    try { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, '.write-test'), 'ok'); console.log(`Workspace folder ${dataDir}: writable`); } catch (e) { console.log(`Workspace folder ${dataDir}: NOT writable (${e.message})`); }
    if (!ok) process.exit(1);
  },
  help() {
    console.log(`Open Gallery ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version}

  open-gallery demo                 Create a fictional sample gallery and open the app
  open-gallery start [--open]       Open your gallery workspace
  open-gallery import FILE [--images DIR] [--apply]
  open-gallery export [--out FILE]  Save a complete backup (.zip)
  open-gallery restore FILE --data EMPTY_FOLDER
  open-gallery build-site [--out DIR]   Make the public website from published works
  open-gallery verify               Check every image and relationship
  open-gallery doctor               Check this computer is ready

Options: --data FOLDER (default ~/Open Gallery), --port N (default 4380)`);
  },
};
try {
  if (!commands[cmd]) { console.error(`Unknown command "${cmd}".`); commands.help(); process.exit(1); }
  await commands[cmd]();
} catch (e) { console.error(e.message); process.exit(1); }
