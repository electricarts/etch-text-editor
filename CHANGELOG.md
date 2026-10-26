# Changelog

All notable changes to this project.

## 1.0.21
- Added: a plugin icon for the WordPress Plugins and Updates screens.
- Changed: the plugin's accent color is now `#DA2E5C`, including buttons, notices, badges and active states.
- Changed: the update metadata reports compatibility through WordPress 7.1.3.

## 1.0.20
- Fixed: the WordPress Update URI response now includes the required `version` field, so the plugin is recognized as update-supported and the automatic-update link appears in the Plugins screen.

## 1.0.19
- Added: WordPress Admin update checks for published GitHub Releases, including the “Update now” flow and plugin information modal.
- Added: a short-lived GitHub release cache and a forced refresh when WordPress checks for updates again.

## 1.0.18
- Added: closing the text editor with the X, Discard or Esc now asks for confirmation when there are unsaved changes; the prompt is in English.
- Changed: the Gutenberg paragraph conversion notice is centered in the viewport instead of appearing in the top-right corner.

## 1.0.17
- Fixed: converted Gutenberg paragraphs are renamed through Etch's block API after replacement, so `Text converted` appears in the structure panel.

## 1.0.16
- Changed: manually converted Gutenberg paragraphs are labeled `Text converted` in the Etch tree so they can be distinguished from native Etch text elements.

## 1.0.15
- Changed: the Etch `Edit` button now uses 12px text at font-weight 600, enforced inside the canvas iframe so the builder's generic button styles cannot override it.

## 1.0.14
- Changed: the Etch `Edit` button is positioned on the left, directly beside the blue selected-element label, instead of at the far right edge of the selected element.

## 1.0.13
- Fixed: the Edit button is rendered inside Etch's canvas iframe, where the builder's generic button rule could override its font. The canvas-specific rule now enforces Etch's interface font.

## 1.0.12
- Fixed: removed the plugin-specific font variable from the font stack. Plugin controls now reference Etch's `var(--e-font-interface)` directly, with Inter and `system-ui` only as fallbacks.

## 1.0.11
- Fixed: Etch/ACSS button rules could override the interface font on plugin controls. The Edit button, popup, conversion notice and canvas toolbar now enforce the resolved Etch interface font.

## 1.0.10
- Changed: plugin controls now use Etch's resolved interface font (`--e-font-interface`, currently Inter) with fallbacks, including the Edit button, conversion notice, popup and canvas toolbar.

## 1.0.9
- New: standalone Gutenberg `core/paragraph` passthroughs are offered for manual conversion to native Etch text elements. Conversion only happens after confirmation; Gutenberg paragraphs inside container passthroughs remain untouched.

## 1.0.8
- Fixed: block-level Gutenberg passthroughs accidentally nested inside native Etch text elements are automatically promoted to the surrounding Etch container on builder load. The Gutenberg blocks remain passthrough blocks.

## 1.0.7
- Changed: removed the diagonal placeholder hatch from Gutenberg passthrough previews; only the solid tint remains.

## 1.0.6
- Fixed: the Gutenberg passthrough highlight is applied only to the passthrough preview block, not to the containing Etch text section.

## 1.0.5
- Changed: Gutenberg passthrough previews now tint their complete containing Etch text section in the canvas; ordinary Etch sections remain untouched.

## 1.0.4
- Fixed: literal `<br>` text introduced when an Etch paragraph is round-tripped through Gutenberg is automatically converted back into a real Etch line-break element.

## 1.0.3
- Added: WordPress plugin and author URLs to link “View Details” to GitHub and the author name to the author website.

## 1.0.2
- Changed: replaced the README screenshot with the updated interface screenshot.

## 1.0.1
- Fixed: all popup toolbar buttons now use the same height and vertical alignment.

## 1.0.0
- First stable release of Etch Text Editor.
- Includes the complete popup editing workflow, inline formatting, ACSS/design-system color tokens, link editing, undo/redo, conflict-safe saving and explanatory toolbar tooltips.
- Updated the README screenshot to show the current color-token workflow.

## 0.22.6
- Changed: the color-token tooltip now describes design-system tokens generally and gives ACSS as an example.

## 0.22.5
- Changed: the color-token tooltip now refers explicitly to **ACSS** instead of a generic design-system token.

## 0.22.4
- New: toolbar buttons now show consistent explanatory tooltips on hover and keyboard focus.

## 0.22.3
- Changed: link editing is now compact by default; URL, **Options**, **Apply** and **Cancel** stay visible, while title, target and `rel` appear on demand. The default popup width is reduced to 640px.

## 0.22.2
- New: a visible **Cancel** button exits link editing without closing the main popup; the current text selection is restored.

## 0.22.1
- Fixed: the popup now opens at 720px by default so the complete link editor, including **Apply**, is visible without manual resizing; it remains responsive on smaller screens.

## 0.22.0
- New: local undo/redo history with toolbar buttons and `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z` or `Ctrl+Y` shortcuts.
- New: link editing supports title, target (`same tab`, `new tab`, parent/top frame) and custom `rel` values; `_blank` links automatically include `noopener`.
- New: safer saving detects changes made outside the popup and offers **Reload latest** or **Keep mine** before overwriting them. Save failures keep the popup open so the user can retry.

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
