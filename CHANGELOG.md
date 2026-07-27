# Changelog

All notable changes to this project.

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
