# Set up Open Gallery by asking an assistant

Paste this into Claude (Claude Code or the desktop app with file access) or Codex on the computer where you want Open Gallery to run:

> Set up Open Gallery from https://github.com/pauljump/open-gallery using a copy of my inventory and images. Keep my current website and marketplace accounts unchanged. Show me a private preview first. Help me match the artwork records, choose a visual style, and create an exhibition catalog. Explain any paid service or public change before doing it. Make sure I can export and restore everything.

The assistant should follow the instructions in the repository's `AGENTS.md`. You should expect it to:

1. Check that Node.js 22.13 or newer is installed, and tell you how to install it if not.
2. Download Open Gallery into its own folder and keep your data in a separate folder (`~/Open Gallery` unless you choose another).
3. Ask where a **copy** of your inventory spreadsheet and image folder are. If you have none ready, start the fictional demo instead.
4. Import a preview and walk you through anything that needs a decision: columns it could not place, possible duplicates, rows with errors.
5. Help you set your gallery name, inquiry email, typefaces and colours using settings, not by editing code.
6. Make one exhibition and open its printable catalog.
7. Make an export, restore it into a scratch folder to prove it works, then delete the scratch copy.

It should **not**: sign you up for anything, upload anything, change your domain or website, contact any marketplace, or call a paid AI service without asking you first.

After setup you do not need the assistant. Open Gallery is an ordinary app: run `open-gallery start --open` (or the shortcut the assistant made) and use it in your browser.

> Status: the repository is public. An assistant run of this prompt has been tested on macOS (see VERIFICATION.md). Codex and a real gallery owner have not tested it yet.
