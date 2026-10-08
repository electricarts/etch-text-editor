# Changelog

All notable changes to this project.

## 0.21.7
- Fixed: the link and unlink buttons now use the exact flat `link-2` and `unlink-2` icon geometry shown in the preview.

## 0.21.6
- Changed: replaced the 3D emoji link/unlink buttons with flat, monochrome outline icons matching the rest of the toolbar.

## 0.21.5
- Fixed: the selection highlight is now actually visible — the inline CSS reset was overriding its background, and the color token dropdown was missing the highlight call.

## 0.21.4
- Fixed: the selection highlight now also appears for the color token ("var") dropdown.

## 0.21.3
- The text selection now stays visible while a dropdown (font weight, color tokens, insert menu, link) is open — it is highlighted instead of disappearing when the editor loses focus.

## 0.21.2
- Dropdown buttons (font weight, color tokens, insert menu) now show a caret indicator; while open they are highlighted and the caret flips.

## 0.21.1
- Wider popup (560px default) so the whole toolbar fits on one row.

## 0.21.0
- New: strikethrough button.
- New: insert menu (¶) with line break, soft hyphen and non-breaking space.
- Link editing: with the caret inside an existing link, the link button opens with the current URL prefilled; Apply updates it. Remove link now also works with just the caret inside a link.
- The double-click workaround now opens the popup editor (consistent with all other entry points).

## 0.20.2
- Toolbar dropdowns (font weight, color tokens, link search) now close when clicking anywhere outside them.

## 0.20.1
- Consistent closing behavior: X, the Close button and clicking outside now all SAVE changes. Discarding is explicit via the new "Discard" button or Esc.

## 0.20.0
- The popup is now resizable (drag the bottom-right corner); the editing area grows with it.
- Pasting now always inserts plain text — all clipboard formatting (Word/Pages colors, font sizes, classes) is stripped.

## 0.19.5
- Reverted the font-weight icon to real font letters (thin/bold "A", equal size) for the cleanest look.

## 0.19.4
- Font-weight icon experiment as a self-contained SVG (reverted in 0.19.5).

## 0.19.3
- The edit button now toggles: a second click closes the popup (saving if changed).

## 0.19.2
- Font-weight icon changed to two "A"s (thin/bold, max weight contrast).

## 0.19.1
- Translated all code comments and log messages to English.

## 0.19.0
- Replaced the "Wt" font-weight dropdown with a line-weight icon button and a labeled weight list (each option previewed in its actual weight).

## 0.18.1
- Literal `<br>` / `<br/>` in the text is now converted to a real line break on save instead of being escaped to `&lt;br&gt;`.

## 0.18.0
- Combine multiple inline styles on the same selection into a single `<span>` (e.g. `font-weight` + `color`) instead of nested spans.

## 0.17.0
- Renamed plugin, folder, main file and script handle to `etch-text-editor`.

## 0.16.x
- Color tokens: pick ACSS / CSS custom-property colors, grouped by family; apply as `color: var(--token)`.
- Fixed stacking of color/weight spans — applying a new value now replaces the old on the same selection (cleans ancestor and descendant spans).

## 0.15.x
- Larger, more prominent edit button.
- Popup opens next to the edited text (iframe-aware positioning); smooth dragging via pointer capture.
- Reset inline elements against global theme/ACSS CSS so links stay inline.

## 0.14.0
- Live canvas preview while editing in the popup.

## 0.13.0
- Internal page/post/media link search in the popup.
- Immediate preview refresh after saving.

## 0.12.0
- Unified: all text (Etch + Gutenberg) is edited through the popup.

## 0.11.0
- Narrower toolbar; removed the explicit Save button (auto-save on click-outside).

## 0.10.0
- Full editing for text inside Gutenberg containers (`core/group`, `core/columns`, …).

## 0.9.0
- Text color, superscript and subscript.

## 0.8.x
- Internal link search including media/files.

## 0.7.0
- Robust "clear formatting"; removed Save button from the canvas toolbar.

## 0.6.x
- Workaround for Etch 1.6.3 inline-link double-click crash.
- Edit button anchored to the text; reliable re-selection.

## 0.5.x
- Floating toolbar with mousedown actions; multi-instance guard.

## 0.4.0
- Direct canvas editing with a floating toolbar.

## 0.3.0
- Canvas preview for Gutenberg blocks; editing of Etch text elements.

## 0.2.0
- Popup editor with inline formatting toolbar.

## 0.1.0
- Proof of concept: read and write Gutenberg passthrough blocks via the Etch Public API.
