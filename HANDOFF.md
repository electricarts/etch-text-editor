# HANDOFF — Etch Text Editor

Status note for picking the project back up (new session, new machine, or another developer).

**Current version:** 1.0.17
**Repo:** https://github.com/electricarts/etch-text-editor
**Local working copy:** `~/Documents/DEV/etch-text-editor`
**License:** GPL-2.0-or-later · **Author:** Mario Peischl

---

## 1. What this is

A WordPress plugin that adds a graphical text-editing popup to the [Etch](https://etchwp.com) builder.

**The problem it solves:** Etch round-trips its own elements to Gutenberg, but text created *in Gutenberg* only passes through to the front end and cannot be edited inside Etch. This plugin closes that gap and adds rich inline formatting on top.

**Explicitly a temporary workaround** until Etch ships native text editing. Version 1.0.0 is the first stable release, but the plugin still depends on Etch's experimental Public API.

---

## 2. Architecture (the important decisions)

### Everything goes through the popup
Earlier versions edited directly in the canvas (`contenteditable` on Etch's own rendered nodes). **That was abandoned on purpose.** Etch's canvas is React-based; writing into its DOM caused re-render crashes, lost selections and flaky behaviour.

Current design: the editing UI lives in the plugin's **own DOM in the top document**, fully decoupled from Etch's canvas React tree. The canvas is only read from (and written to as a *visual* live preview). All persistence goes through the public API.

The old inline-session code (`startSession`, `commitLive`, canvas toolbar) is still present but **no longer called**. It could be deleted — kept so far in case an inline mode is ever wanted again.

### Persistence
Always via the Etch Public API: `etch.blocks.replace(...)` + `etch.saveAsync()`.

Three persist paths in `editor.js`:

| Function | Target | Notes |
|---|---|---|
| `persistEtch()` | Etch text elements (`etch/element` + `etch/text` children) | Children are serialized to inline HTML, edited, converted back to a block tree |
| `persistGb()` | Single Gutenberg passthrough blocks | Rewrites `gutenbergBlock.innerHTML` / `innerContent`; block stays a core block → two-way sync preserved |
| `persistGbNested()` | Text inside Gutenberg containers (group, columns) | Patches only the affected nested block, writes the whole passthrough back; container wrapper (incl. `innerContent` null placeholders) untouched |

### Entry points
- `✎ Edit` button, positioned next to the selected text in the canvas (toggles the popup)
- Click on a `GB` canvas preview (Gutenberg passthrough)
- Click on a line inside a container preview (nested Gutenberg text)
- Double-click guard (see "Etch bug" below) — also opens the popup

Selection is **polled** (`etch.blocks.getSelectedId()`), because the 0.x API has no events.

---

## 3. Hard-won knowledge (do not re-learn this the hard way)

**Never persist `etch-*` classes.** Etch adds runtime classes (`etch-html-block`, `etch-builder-block`) to rendered nodes. Writing them back produced broken style references and `Error rendering block: Cannot read properties of undefined (reading 'count')`. They are filtered out in both serialization and the sanitizer.

**New block nodes need real templates.** Creating nodes with a minimal shape (`version: 1, context: {}`) is accepted by the API but breaks Etch's renderer. `findTemplates()` / `baseFrom()` clone `version` / `context` / `options` from natively created blocks in the document.

**Etch 1.6.3 bug:** double-clicking a paragraph that contains an inline link crashes Etch's own inline editor (`reading 'count'`). Reproducible with the plugin disabled → it is an Etch bug, not ours. Workaround: a capture-phase `dblclick` guard intercepts the double-click on text containing `<a>` and opens our popup instead. **Remove this once Etch fixes it.**

**The inline CSS reset bites back.** `.eppe-editor span { background: transparent !important; ... }` (needed so global theme/ACSS CSS doesn't push links onto their own line) silently killed the selection-highlight background. Any new editor styling must out-specify that reset.

**ACSS tokens live in `@layer` blocks and often in the canvas iframe**, not the top document. `collectAllVars()` recurses into grouping rules and scans iframes. Etch's own variables (`--e-*`, `--etch-*`, `--lightningcss-*`) are filtered out; what remains is the ACSS palette.

**Console context matters.** When debugging in the browser console, the context dropdown must be on **top**, not `etch-iframe` — otherwise `window.etch` is `undefined`.

**Page cache.** The user runs LiteSpeed. After every plugin update: *Purge All* + hard reload, otherwise the builder serves the old script.

---

## 4. Feature set (as of 1.0.5)

Formatting: bold, italic, strikethrough, superscript, subscript, font-weight (dropdown), text color (native picker **and** theme tokens via `var(--token)`), flat monochrome link/unlink icons, clear formatting, local undo/redo.

Insert menu (¶): line break, soft hyphen (`&shy;`), non-breaking space (`&nbsp;`).

Links: type a URL **or** search internal pages/posts/media via the WordPress REST API (`/wp/v2/search` + `/wp/v2/media`). Caret inside an existing link → opens prefilled for editing; title, target and `rel` are editable; unlink works from the caret too.

Behaviour: paste is always plain text; multiple inline styles on one selection merge into a single `<span>`; literal `<br>` values returned by Gutenberg are automatically normalized into real Etch line-break elements; popup is draggable (header) and resizable (bottom-right corner), opens next to the edited text; dropdowns show a caret and highlight while open and close on outside click; the selection stays visibly highlighted while a dropdown is open; toolbar buttons show explanatory hover/focus tooltips.

Saving: closing saves (X, Close button, click outside, Cmd/Ctrl+Enter). Discarding is explicit (Discard button or Esc). External changes are detected before overwriting; save errors keep the popup open for retry.

---

## 5. Repo & release workflow

Files in the repo: `etch-text-editor.php`, `editor.js`, `README.md`, `CHANGELOG.md`, `LICENSE`, `.gitignore`, `assets/popup.png` (README screenshot).

`.gitignore` excludes `*.zip` — release ZIPs are attached to GitHub Releases, not committed.

Release steps:

```bash
# 1. bump version in etch-text-editor.php AND the editor.js header + const VERSION
# 2. add a CHANGELOG.md entry
git add -A
git commit -m "X.Y.Z: short summary"
git push
git tag vX.Y.Z
git push origin vX.Y.Z
# 3. GitHub → Releases → Draft a new release → pick the tag
#    → attach etch-text-editor-X.Y.Z.zip → publish as a normal release
```

The release ZIP must contain the folder `etch-text-editor/` at its root so WordPress installs it correctly.

Pre-releases do **not** appear under `/releases/latest` — share the direct tag URL instead.

**Careful with `<br>` and `<span>` in release notes / Circle posts:** both GitHub and Circle render Markdown, so bare tags are interpreted as HTML. Wrap them in backticks.

---

## 6. Known limitations / open points

- The Etch Public API is experimental (0.x) — Etch updates may break this.
- Nested container text is edited in the popup only (there is no per-paragraph canvas node inside a container).
- The canvas live preview writes into Etch's rendered DOM; visual only, reconciled on save.
- Standalone Gutenberg `core/paragraph` passthroughs are offered for manual conversion to native Etch text elements. Conversion is opt-in; nested paragraphs inside Gutenberg container passthroughs remain Gutenberg-owned.
- Resizing uses the native CSS resize handle → bottom-right corner only. Handles on all corners would need a custom implementation.
- The unused inline-editing code could be removed for clarity.
- Idea discussed but deliberately **not** built: a Settings Bar button via `window.etchControls.builder.settingsBar` as an additional entry point. That API only supports buttons (icon + tooltip + callback), **not** form controls — so the toolbar itself can never live there.
- Deliberately rejected features: underline (clashes with link convention), inline font-size / text-transform / letter-spacing (breaks the design system), highlight/`<mark>`.

---

## 7. Community / communication

A launch post and an update post for the Etch Circle community were drafted (casual tone, English). Standing rules for those: mention that it is a pre-release tested only by the author, that it was built with the help of Claude (AI), use at your own risk / not on production / back up first, and that it is a temporary workaround until Etch offers native text editing. Always link the repo and invite forks, issues and PRs.
