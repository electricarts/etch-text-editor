/**
 * Etch Text Editor — Gutenberg link controls
 * ------------------------------------------
 * Adds link editing to Etch anchor elements in the WordPress block editor.
 *
 * Etch stores a link as an `etch/element` block with `tag: "a"` and the
 * actual URL in its `attributes` object. The linked words remain child
 * `etch/text` blocks. Gutenberg can edit those words, but Etch's default
 * block editor UI does not expose the anchor attributes. This small editor
 * extension adds a normal Inspector Controls panel without replacing Etch's
 * block implementation or changing its serialized block shape.
 */
(() => {
	"use strict";

	const wp = window.wp;
	if (!wp || !wp.hooks || !wp.compose || !wp.element || !wp.components) return;

	const { addFilter } = wp.hooks;
	const { createHigherOrderComponent } = wp.compose;
	const { createElement, Fragment, useEffect, useState } = wp.element;
	const { useSelect } = wp.data || {};
	const blockEditor = wp.blockEditor || wp.editor || {};
	const {
		InspectorControls,
	} = blockEditor;
	const {
		PanelBody,
		TextControl,
		SelectControl,
		Button,
		Notice,
	} = wp.components;

	if (!InspectorControls || !PanelBody || !TextControl || !SelectControl || !Button || !Notice || !useSelect) return;

	const SAFE_PROTOCOLS = new Set([
		"http:", "https:", "mailto:", "tel:", "sms:", "irc:", "ircs:",
		"xmpp:", "webcal:", "ftp:", "ftps:", "news:", "gopher:", "nntp:", "feed:",
	]);
	const SAFE_TARGETS = new Set(["", "_self", "_blank", "_parent", "_top"]);
	const REL_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

	function isSafeHref(value) {
		const href = String(value || "").trim();
		if (!href || /[\u0000-\u001f\u007f]/.test(href)) return false;

		try {
			const parsed = new URL(href, window.location.origin + "/");
			if (parsed.origin === window.location.origin) return true;
			return SAFE_PROTOCOLS.has(parsed.protocol.toLowerCase());
		} catch (_) {
			return false;
		}
	}

	function cleanText(value) {
		return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
	}

	function cleanRel(value) {
		return String(value || "")
			.trim()
			.split(/\s+/)
			.filter((token) => REL_TOKEN_RE.test(token))
			.join(" ");
	}

	function addRelToken(rel, token) {
		const tokens = cleanRel(rel).split(/\s+/).filter(Boolean);
		if (!tokens.includes(token)) tokens.push(token);
		return tokens.join(" ");
	}

	function isEtchAnchor(props) {
		return Boolean(
			props &&
			props.name === "etch/element" &&
			props.attributes &&
			String(props.attributes.tag || "").toLowerCase() === "a"
		);
	}

	function currentLinkAttributes(props) {
		const attrs = props && props.attributes && props.attributes.attributes;
		return attrs && typeof attrs === "object" ? attrs : {};
	}

	function LinkInspector({ block, setAttributes, inherited }) {
		const attrs = currentLinkAttributes(block);
		const [draft, setDraft] = useState({
			href: String(attrs.href || ""),
			title: String(attrs.title || ""),
			target: SAFE_TARGETS.has(String(attrs.target || "")) ? String(attrs.target || "") : "",
			rel: String(attrs.rel || ""),
		});
		const [error, setError] = useState("");

		useEffect(() => {
			setDraft({
				href: String(attrs.href || ""),
				title: String(attrs.title || ""),
				target: SAFE_TARGETS.has(String(attrs.target || "")) ? String(attrs.target || "") : "",
				rel: String(attrs.rel || ""),
			});
			setError("");
		}, [attrs.href, attrs.title, attrs.target, attrs.rel]);

		const setDraftValue = (key, value) => {
			setError("");
			setDraft((current) => ({ ...current, [key]: value }));
		};

		const apply = () => {
			const href = cleanText(draft.href);
			const target = SAFE_TARGETS.has(draft.target) ? draft.target : "";
			if (href && !isSafeHref(href)) {
				setError("Please enter a valid and safe URL.");
				return;
			}

			const next = { ...attrs };
			if (href) next.href = href;
			else delete next.href;

			const title = cleanText(draft.title);
			if (title) next.title = title;
			else delete next.title;

			if (target) next.target = target;
			else delete next.target;

			let rel = cleanRel(draft.rel);
			if (target === "_blank") rel = addRelToken(rel, "noopener");
			if (rel) next.rel = rel;
			else delete next.rel;

			setAttributes({ attributes: next });
			setDraft({ href, title, target, rel });
			setError("");
		};

		const removeHref = () => {
			const next = { ...attrs };
			delete next.href;
			delete next.title;
			delete next.target;
			delete next.rel;
			setAttributes({ attributes: next });
			setDraft((current) => ({ ...current, href: "", target: "", rel: "" }));
			setError("");
		};

		return createElement(
			InspectorControls,
			null,
			createElement(
				PanelBody,
				{ title: "Link", initialOpen: true },
				inherited && createElement(
					Notice,
					{ status: "info", isDismissible: false },
					"This link is stored on the parent Etch Element."
				),
				error && createElement(Notice, { status: "error", isDismissible: false }, error),
				createElement(TextControl, {
					label: "URL",
					value: draft.href,
					onChange: (value) => setDraftValue("href", value),
					placeholder: "https://…",
					autoComplete: "url",
				}),
				createElement(TextControl, {
					label: "Title",
					value: draft.title,
					onChange: (value) => setDraftValue("title", value),
					placeholder: "Optional link title",
				}),
				createElement(SelectControl, {
					label: "Target",
					value: draft.target,
					onChange: (value) => setDraftValue("target", value),
					options: [
						{ label: "Default", value: "" },
						{ label: "Same tab", value: "_self" },
						{ label: "New tab", value: "_blank" },
						{ label: "Parent frame", value: "_parent" },
						{ label: "Top frame", value: "_top" },
					],
				}),
				createElement(TextControl, {
					label: "rel",
					value: draft.rel,
					onChange: (value) => setDraftValue("rel", value),
					placeholder: "Optional relationship",
					help: draft.target === "_blank" ? "noopener is added automatically." : undefined,
				}),
				createElement(
					"div",
					{ className: "eppe-gb-link-actions", style: { display: "flex", gap: "8px", marginTop: "8px" } },
					createElement(Button, { variant: "primary", onClick: apply }, "Apply"),
					hrefValue(attrs) && createElement(Button, { variant: "tertiary", onClick: removeHref }, "Remove link")
				)
			)
		);
	}

	function hrefValue(attrs) {
		return String(attrs && attrs.href ? attrs.href : "");
	}

	function useParentEtchAnchor(props) {
		return useSelect((select) => {
			if (!props || props.name !== "etch/text" || !props.clientId) return null;

			const blockEditor = select("core/block-editor");
			if (!blockEditor || typeof blockEditor.getBlockParents !== "function" || typeof blockEditor.getBlocksByClientId !== "function") {
				return null;
			}

			const parentIds = blockEditor.getBlockParents(props.clientId, true) || [];
			const parents = blockEditor.getBlocksByClientId(parentIds) || [];
			const anchor = parents.find((block) => isEtchAnchor(block));
			return anchor ? { clientId: anchor.clientId, block: anchor } : null;
		}, [props && props.clientId, props && props.name]);
	}

	const withEtchLinkControls = createHigherOrderComponent((BlockEdit) => (props) => {
		const parentAnchor = useParentEtchAnchor(props);
		let target = null;
		let inherited = false;

		if (isEtchAnchor(props)) {
			target = {
				block: props,
				setAttributes: props.setAttributes,
			};
		} else if (parentAnchor) {
			const blockEditorDispatch = wp.data.dispatch("core/block-editor");
			target = {
				block: parentAnchor.block,
				setAttributes: (attributes) => blockEditorDispatch.updateBlockAttributes(parentAnchor.clientId, attributes),
			};
			inherited = true;
		}

		if (!target) return createElement(BlockEdit, props);

		return createElement(
			Fragment,
			null,
			createElement(BlockEdit, props),
			createElement(LinkInspector, { ...target, inherited })
		);
	}, "withEtchLinkControls");

	addFilter("editor.BlockEdit", "eppe/etch-link-controls", withEtchLinkControls);
})();
