/**
 * Etch Text Editor v1.0.15
 * ------------------------------------
 * Graphical text-editing popup for the Etch builder:
 *  - Gutenberg passthrough blocks (core/paragraph, core/heading, …):
 *    click the canvas preview to edit. Saved via replace() → the block
 *    stays a core block, so Etch <-> Gutenberg two-way sync is preserved.
 *  - Etch text elements (p, h1–h6, li, …): select in the builder → the
 *    "✎ Edit" button appears next to the text → opens the popup.
 *  - Text nested in Gutenberg containers (core/group, core/columns, …):
 *    edited through the popup as well.
 *  - Popup toolbar: bold (strong), italic (em), superscript, subscript,
 *    font-weight, text color (incl. theme tokens), link (with internal
 *    search), clear formatting. Auto-save on click-outside / Cmd+Enter.
 *
 * All editing runs through the popup (decoupled from Etch's canvas React
 * tree). Writes go through the Etch Public API (replace + saveAsync).
 * Legacy literal `<br>` text returned by Gutenberg is normalized back to
 * real Etch line-break elements automatically.
 */
(() => {
	"use strict";

	const VERSION = "1.0.15";
	const TIMEOUT_MS = 15000;
	const POLL_MS = 300;
	const PREVIEW_MS = 1000;

	const EDITABLE_GB_BLOCKS = ["core/paragraph", "core/heading", "core/preformatted", "core/verse"];
	const GB_LABELS = {
		"core/paragraph": "Paragraph",
		"core/heading": "Heading",
		"core/preformatted": "Preformatted",
		"core/verse": "Verse",
	};

	/* Flat, monochrome toolbar icons (kept inline so the editor has no icon dependency). */
	const LINK_ICON_SVG =
		`<svg class="eppe-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
		`<path d="M9 17H7A5 5 0 0 1 7 7h2"/>` +
		`<path d="M15 7h2a5 5 0 1 1 0 10h-2"/>` +
		`<line x1="8" x2="16" y1="12" y2="12"/>` +
		`</svg>`;
	const UNLINK_ICON_SVG =
		`<svg class="eppe-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
		`<path d="M15 7h2a5 5 0 0 1 0 10h-2m-6 0H7A5 5 0 0 1 7 7h2"/>` +
		`</svg>`;

	const ETCH_TEXT_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "figcaption"];
	const INLINE_TAGS = ["a", "strong", "em", "span", "br", "code", "mark", "s", "sub", "sup", "u"];
	const ALLOWED_TAGS = INLINE_TAGS.map((t) => t.toUpperCase());

	const log = (...a) => console.log("%c[EtchPPE]", "color:#7c3aed;font-weight:bold", ...a);
	const err = (...a) => console.error("%c[EtchPPE]", "color:#dc2626;font-weight:bold", ...a);
	const apiErrInfo = (e) =>
		e && e.name === "EtchApiError" ? `[${e.code}] ${e.message}` : String(e);

	const escapeHtml = (s) =>
		String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");
	const normText = (s) => String(s || "").replace(/\s+/g, " ").trim();

	/* ================================================================== */
	/* Block-Helpers                                                       */
	/* ================================================================== */

	function toAuthoring(block) {
		const { id, parentId, styles, children = [], ...rest } = block;
		return { ...rest, children: children.map(toAuthoring) };
	}

	function parseOuter(innerHTML) {
		const doc = new DOMParser().parseFromString(innerHTML, "text/html");
		return doc.body.firstElementChild;
	}

	function collectPassthroughs(etch) {
		const out = [];
		const walk = (nodes) =>
			(nodes || []).forEach((n) => {
				if (n.type === "etch/passthrough" && n.gutenbergBlock) out.push(n);
				walk(n.children);
			});
		try {
			walk(etch.blocks.getTree());
		} catch (_) { /* builder in a transitional state */ }
		return out;
	}

	function isEditableGb(block) {
		if (!block || block.type !== "etch/passthrough" || !block.gutenbergBlock) return false;
		const gb = block.gutenbergBlock;
		if (!EDITABLE_GB_BLOCKS.includes(gb.blockName)) return false;
		if (gb.innerBlocks && gb.innerBlocks.length) return false;
		return (gb.innerContent || []).filter((s) => typeof s === "string").length <= 1;
	}

	/** Ist ein einzelner Gutenberg-Block ein einfach bearbeitbarer Textblock? */
	function isSimpleTextGb(gb) {
		if (!gb || !EDITABLE_GB_BLOCKS.includes(gb.blockName)) return false;
		if (gb.innerBlocks && gb.innerBlocks.length) return false;
		return (gb.innerContent || []).filter((s) => typeof s === "string").length <= 1;
	}

	/** A block-level Gutenberg passthrough that must not live inside an Etch
	 * text element (core/paragraph renders its own <p>, for example). */
	function isBlockGbPassthrough(node) {
		return !!(
			node &&
			node.type === "etch/passthrough" &&
			node.gutenbergBlock &&
			EDITABLE_GB_BLOCKS.includes(node.gutenbergBlock.blockName)
		);
	}

	/**
	 * Collect editable text blocks nested inside a container block
	 * (core/group, core/columns, core/column, …).
	 * Returns objects with `path` (index chain in innerBlocks), blockName and innerHTML.
	 */
	function collectNestedEditable(gb, path) {
		path = path || [];
		const out = [];
		(gb.innerBlocks || []).forEach((child, i) => {
			const p = path.concat(i);
			if (isSimpleTextGb(child)) {
				out.push({ path: p, blockName: child.blockName, innerHTML: child.innerHTML });
			} else if (child.innerBlocks && child.innerBlocks.length) {
				out.push(...collectNestedEditable(child, p));
			}
		});
		return out;
	}

	/** Passthrough container with at least one nested text block? */
	function isContainerPassthrough(block) {
		if (!block || block.type !== "etch/passthrough" || !block.gutenbergBlock) return false;
		const gb = block.gutenbergBlock;
		if (!gb.innerBlocks || !gb.innerBlocks.length) return false;
		return collectNestedEditable(gb).length > 0;
	}

	/** Get the innermost Gutenberg block via an index chain (path) */
	function nestedBlockAt(gb, path) {
		let node = gb;
		for (const idx of path) {
			if (!node.innerBlocks || !node.innerBlocks[idx]) return null;
			node = node.innerBlocks[idx];
		}
		return node;
	}

	/* ---- Etch-Element ↔ HTML ------------------------------------------ */

	function childrenToHtml(children) {
		let html = "";
		for (const c of children || []) {
			if (c.type === "etch/text") {
				html += escapeHtml(c.text || "");
				continue;
			}
			if (c.type === "etch/element") {
				const tag = (c.tag || "span").toLowerCase();
				if (!INLINE_TAGS.includes(tag)) return null;
				const attrs = { ...(c.attributes || {}) };
				/* Filter out Etch-internal runtime classes; deliberately do NOT
				   serialize styles (style IDs) as classes */
				if (attrs.class != null) {
					const cls = String(attrs.class).split(/\s+/).filter((x) => x && !/^etch-/.test(x));
					if (cls.length) attrs.class = cls.join(" ");
					else delete attrs.class;
				}
				const attrStr = Object.entries(attrs)
					.filter(([, v]) => v != null)
					.map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
					.join("");
				if (tag === "br") {
					html += "<br>";
					continue;
				}
				const inner = childrenToHtml(c.children);
				if (inner === null) return null;
				html += `<${tag}${attrStr}>${inner}</${tag}>`;
				continue;
			}
			return null;
		}
		return html;
	}

	/**
	 * Templates for new nodes: clone version/context/options from natively
	 * created blocks in the document. Minimal shapes (version:1, context:{})
	 * are accepted by the API, but Etch's renderer expects additional
	 * internal fields on native blocks → "Error rendering block".
	 */
	function findTemplates(etch) {
		let textTpl = null;
		let elTpl = null;
		const walk = (nodes) =>
			(nodes || []).forEach((n) => {
				if (n.type === "etch/text" && !textTpl) textTpl = n;
				if (n.type === "etch/element" && !elTpl) elTpl = n;
				if (!textTpl || !elTpl) walk(n.children);
			});
		try {
			walk(etch.blocks.getTree());
		} catch (_) { /* transitional state */ }
		return { textTpl, elTpl };
	}

	function baseFrom(tpl) {
		if (!tpl) return { version: 1, context: {} };
		const base = {
			version: tpl.version ?? 1,
			context: JSON.parse(JSON.stringify(tpl.context || {})),
		};
		delete base.context.name; // don't carry over the template block's label
		delete base.context.structureState;
		if (tpl.options) base.options = JSON.parse(JSON.stringify(tpl.options));
		return base;
	}

	function htmlToChildren(container, tpls) {
		const children = [];
		container.childNodes.forEach((node) => {
			if (node.nodeType === 3) {
				if (node.nodeValue) {
					children.push({
						type: "etch/text",
						...baseFrom(tpls && tpls.textTpl),
						children: [],
						text: node.nodeValue,
					});
				}
				return;
			}
			if (node.nodeType !== 1) return;
			const tag = node.tagName.toLowerCase();
			if (!INLINE_TAGS.includes(tag)) {
				children.push(...htmlToChildren(node, tpls));
				return;
			}
			const attributes = {};
			for (const a of node.attributes) {
				if (a.name === "class") {
					/* NEVER persist Etch-internal runtime classes (etch-html-block etc.)
					   – they create broken style references */
					const cls = a.value.split(/\s+/).filter((x) => x && !/^etch-/.test(x));
					if (cls.length) attributes.class = cls.join(" ");
				} else {
					attributes[a.name] = a.value;
				}
			}
			const el = {
				type: "etch/element",
				...baseFrom(tpls && tpls.elTpl),
				tag,
				attributes,
				children: [],
			};
			el.children = tag === "br" ? [] : htmlToChildren(node, tpls);
			children.push(el);
		});
		return children;
	}

	const LEGACY_BR_RE = /<br\s*\/?>/i;

	/**
	 * Etch can receive a Gutenberg line break as literal text (`"<br>"`)
	 * when an Etch paragraph is round-tripped through Gutenberg. Keep the
	 * repair narrowly scoped to that exact legacy representation.
	 */
	function hasLegacyBrText(children) {
		return (children || []).some((c) => {
			if (c.type === "etch/text") return LEGACY_BR_RE.test(String(c.text || ""));
			return hasLegacyBrText(c.children);
		});
	}

	/** Convert literal `<br>` text nodes into real Etch `br` element nodes. */
	function normalizeLegacyBrChildren(children, tpls) {
		const out = [];
		const re = /<br\s*\/?>/gi;
		(children || []).forEach((c) => {
			if (c.type === "etch/text") {
				const text = String(c.text || "");
				if (!LEGACY_BR_RE.test(text)) {
					out.push(c);
					return;
				}
				let last = 0;
				let match;
				re.lastIndex = 0;
				while ((match = re.exec(text))) {
					if (match.index > last) {
						out.push({ ...c, children: [], text: text.slice(last, match.index) });
					}
					out.push({
						type: "etch/element",
						...baseFrom(tpls && tpls.elTpl),
						tag: "br",
						attributes: {},
						children: [],
					});
					last = match.index + match[0].length;
				}
				if (last < text.length) {
					out.push({ ...c, children: [], text: text.slice(last) });
				}
				return;
			}

			const copy = { ...c };
			if (Array.isArray(c.children)) copy.children = normalizeLegacyBrChildren(c.children, tpls);
			out.push(copy);
		});
		return out;
	}

	function containsBlockId(block, id) {
		if (!block || !id) return false;
		if (block.id === id) return true;
		return (block.children || []).some((child) => containsBlockId(child, id));
	}

	function elementDescendants(block) {
		const out = [];
		const walk = (b) =>
			(b.children || []).forEach((c) => {
				if (c.type === "etch/element") out.push(c);
				walk(c);
			});
		walk(block);
		return out;
	}

	function resolveEtchTarget(etch, block, depth = 0) {
		if (!block || depth > 10) return null;
		const parent = () => {
			if (!block.parentId) return null;
			try {
				return resolveEtchTarget(etch, etch.blocks.getJson(block.parentId), depth + 1);
			} catch (_) {
				return null;
			}
		};
		if (block.type === "etch/text") return parent();
		if (block.type !== "etch/element") return null;
		const tag = (block.tag || "").toLowerCase();
		if (INLINE_TAGS.includes(tag)) {
			const container = parent();
			if (container) return container;
			return childrenToHtml(block.children) !== null ? block : null;
		}
		if (!ETCH_TEXT_TAGS.includes(tag)) return null;
		if (childrenToHtml(block.children) === null) return null;
		return block;
	}

	/* ================================================================== */
	/* Sanitizer                                                           */
	/* ================================================================== */

	/** Merge nested plain <span> wrappers into ONE span with combined
	    style properties (e.g. font-weight + color).
	    Only spans without a class that contain exactly one span as their sole content. */
	function coalesceSpans(rootEl) {
		let changed = true;
		while (changed) {
			changed = false;
			rootEl.querySelectorAll("span").forEach((s) => {
				if (s.className) return;
				const kids = Array.from(s.childNodes).filter(
					(n) => !(n.nodeType === 3 && !n.nodeValue.trim())
				);
				if (kids.length === 1 && kids[0].nodeType === 1 &&
					kids[0].tagName === "SPAN" && !kids[0].className) {
					const child = kids[0];
					const cs = child.style;
					for (let i = 0; i < cs.length; i++) {
						const p = cs[i];
						s.style.setProperty(p, cs.getPropertyValue(p));
					}
					while (child.firstChild) s.insertBefore(child.firstChild, child);
					child.remove();
					changed = true;
				}
			});
		}
	}

	/** Paste as plain text: strips ALL formatting from pasted content
	    (Word/Pages clipboard HTML brings colors, font sizes, classes, …). */
	function handlePlainPaste(e, doc) {
		const cb = e.clipboardData;
		if (!cb) return;
		e.preventDefault();
		const text = cb.getData("text/plain");
		if (text) (doc || document).execCommand("insertText", false, text);
	}

	/** Leere Inline-Elemente rekursiv auspacken (z. B. <strong></strong>-Reste) */
	function stripEmptyInline(rootEl) {
		let changed = true;
		while (changed) {
			changed = false;
			rootEl.querySelectorAll(INLINE_TAGS.filter((t) => t !== "br").join(",")).forEach((n) => {
				if (n.textContent.trim() || n.querySelector("br,img")) return;
				while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
				n.remove();
				changed = true;
			});
		}
	}

	/** Convert literal "<br>" / "<br/>" / "<br />" in text nodes into real
	    <br> elements (typed or escaped line breaks). */
	function convertLiteralBr(rootEl) {
		const doc = rootEl.ownerDocument;
		const re = /<br\s*\/?>/gi;
		const texts = [];
		const walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) texts.push(walker.currentNode);
		texts.forEach((tn) => {
			const s = tn.nodeValue;
			if (!/<br\s*\/?>/i.test(s)) return;
			const frag = doc.createDocumentFragment();
			let last = 0, m;
			re.lastIndex = 0;
			while ((m = re.exec(s))) {
				if (m.index > last) frag.appendChild(doc.createTextNode(s.slice(last, m.index)));
				frag.appendChild(doc.createElement("br"));
				last = m.index + m[0].length;
			}
			if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
			tn.parentNode.replaceChild(frag, tn);
		});
	}

	function sanitizeEditorHtml(rootEl) {
		convertLiteralBr(rootEl); // typed/escaped <br> into real line breaks
		const doc = rootEl.ownerDocument;
		["b", "i"].forEach((tag) => {
			rootEl.querySelectorAll(tag).forEach((el) => {
				const repl = doc.createElement(tag === "b" ? "strong" : "em");
				while (el.firstChild) repl.appendChild(el.firstChild);
				el.replaceWith(repl);
			});
		});
		const walk = (el) => {
			Array.from(el.children).forEach((child) => {
				walk(child);
				if (!ALLOWED_TAGS.includes(child.tagName)) {
					while (child.firstChild) el.insertBefore(child.firstChild, child);
					child.remove();
					return;
				}
				Array.from(child.attributes).forEach((attr) => {
					const n = attr.name.toLowerCase();
					const keep =
						(child.tagName === "A" && ["href", "target", "rel", "title"].includes(n)) ||
						(child.tagName === "SPAN" && ["style", "class"].includes(n)) ||
						n === "class";
					if (!keep || n.startsWith("on")) child.removeAttribute(attr.name);
				});
				/* Remove Etch-internal runtime classes (etch-html-block etc.) */
				if (child.hasAttribute("class")) {
					const cls = child.getAttribute("class").split(/\s+/).filter((x) => x && !/^etch-/.test(x));
					if (cls.length) child.setAttribute("class", cls.join(" "));
					else child.removeAttribute("class");
				}
				if (child.tagName === "A") {
					const href = (child.getAttribute("href") || "").trim();
					if (/^javascript:/i.test(href)) child.removeAttribute("href");
					if (child.getAttribute("target") === "_blank") child.setAttribute("rel", "noopener");
				}
				if (child.tagName === "SPAN" && child.hasAttribute("style")) {
					const fw = child.style.fontWeight;
					const fs = child.style.fontStyle;
					const col = child.style.color;
					child.removeAttribute("style");
					if (fw) child.style.fontWeight = fw;
					if (fs) child.style.fontStyle = fs;
					if (col) child.style.color = col;
					if (!child.getAttribute("style") && !child.className) {
						while (child.firstChild) el.insertBefore(child.firstChild, child);
						child.remove();
					}
				}
			});
		};
		/* remove the temporary selection highlight wrapper, if present */
		rootEl.querySelectorAll(".eppe-selhl").forEach((n) => {
			while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
			n.remove();
		});
		walk(rootEl);
		coalesceSpans(rootEl);   // merge nested spans into one
		stripEmptyInline(rootEl); // remove empty leftovers (e.g. after removeFormat)
		return rootEl.innerHTML;
	}

	/* ================================================================== */
	/* Interne Link-Suche (WordPress REST API)                             */
	/* ================================================================== */

	function restRoot() {
		/* wpApiSettings.root is usually present in the builder; otherwise a default path */
		try {
			if (window.wpApiSettings && window.wpApiSettings.root) return window.wpApiSettings.root;
		} catch (_) { /* ignore */ }
		return window.location.origin + "/wp-json/";
	}

	function restHeaders() {
		const headers = {};
		try {
			if (window.wpApiSettings && window.wpApiSettings.nonce) headers["X-WP-Nonce"] = window.wpApiSettings.nonce;
		} catch (_) { /* ignore */ }
		return headers;
	}

	/** Pages & posts via the search API */
	async function searchContent(query) {
		const root = restRoot().replace(/\/$/, "/");
		const url = root + "wp/v2/search?" + new URLSearchParams({
			search: query,
			per_page: "6",
			subtype: "any",
			type: "post",
			_fields: "id,title,url,subtype",
		});
		const res = await fetch(url, { headers: restHeaders(), credentials: "same-origin" });
		if (!res.ok) throw new Error("REST search " + res.status);
		const data = await res.json();
		return (Array.isArray(data) ? data : []).map((r) => ({
			title: (r.title || "").toString(),
			url: r.url || "",
			type: r.subtype || "page",
		}));
	}

	/** Media/files via the media endpoint */
	async function searchMedia(query) {
		const root = restRoot().replace(/\/$/, "/");
		const url = root + "wp/v2/media?" + new URLSearchParams({
			search: query,
			per_page: "6",
			_fields: "id,title,source_url,mime_type",
		});
		const res = await fetch(url, { headers: restHeaders(), credentials: "same-origin" });
		if (!res.ok) throw new Error("REST media " + res.status);
		const data = await res.json();
		return (Array.isArray(data) ? data : []).map((r) => {
			const ext = (r.source_url || "").split(".").pop().split(/[?#]/)[0];
			return {
				title: (r.title && r.title.rendered ? r.title.rendered : r.source_url) || "",
				url: r.source_url || "",
				type: ext ? ext.toLowerCase() : "file",
			};
		});
	}

	/** Both sources in parallel; individual errors are non-fatal */
	async function searchInternal(query) {
		const [content, media] = await Promise.all([
			searchContent(query).catch((e) => { log("Content search:", String(e)); return []; }),
			searchMedia(query).catch((e) => { log("Media search:", String(e)); return []; }),
		]);
		return [...content, ...media].filter((r) => r.url).slice(0, 10);
	}

	/* ================================================================== */
	/* CSS-Variablen / Design-Tokens sammeln                               */
	/* ================================================================== */

	/** Alle CSS-Custom-Properties aus Dokument + iframes einsammeln
	    (steigt in @layer/@media/@supports ab). */
	function collectAllVars() {
		const vars = {};
		const addFromRules = (rules) => {
			for (const r of rules || []) {
				if (r.style) {
					for (const p of r.style) {
						if (p.startsWith("--")) {
							const v = r.style.getPropertyValue(p).trim();
							if (v) vars[p] = v;
						}
					}
				}
				if (r.cssRules) addFromRules(r.cssRules);
			}
		};
		const scanDoc = (doc) => {
			for (const sheet of doc.styleSheets) {
				let rules;
				try { rules = sheet.cssRules; } catch (_) { continue; }
				addFromRules(rules);
			}
		};
		try { scanDoc(document); } catch (_) { /* ignore */ }
		iframeDocs().forEach((d) => { try { scanDoc(d); } catch (_) { /* ignore */ } });
		return vars;
	}

	/** Only real color tokens, excluding Etch/builder-internal variables. */
	function colorTokenNames(vars) {
		const EXCLUDE = /^--(e-|etch|lightningcss|stripe|wp-|admin-)/i;
		const isColor = (v) => /#|rgb|hsl|oklch|oklab|color-mix/i.test(v) || /^var\(/i.test(v);
		return Object.keys(vars)
			.filter((n) => !EXCLUDE.test(n) && isColor(vars[n]))
			.sort();
	}

	/* Preferred order of the ACSS color families */
	const TOKEN_FAMILY_ORDER = [
		"primary", "secondary", "tertiary", "accent", "base", "shade", "neutral",
		"action", "success", "danger", "error", "warning", "info",
		"white", "black", "pure-white", "pure-black", "text", "heading", "link",
	];
	/* Shades (lighter → darker); base tone (no suffix) first */
	const TOKEN_MOD = /-(trans-\d+|ultra-light|semi-light|light|hover|semi-dark|ultra-dark|dark)$/;
	const TOKEN_MOD_RANK = {
		"": 0, "ultra-light": 1, "light": 2, "semi-light": 3, "hover": 4,
		"semi-dark": 5, "dark": 6, "ultra-dark": 7,
	};

	/** Group tokens by family and order them sensibly. */
	function groupColorTokens(names) {
		const groups = {};
		names.forEach((n) => {
			const bare = n.replace(/^--/, "");
			const m = bare.match(TOKEN_MOD);
			const mod = m ? m[1] : "";
			const family = m ? bare.slice(0, bare.length - m[0].length) : bare;
			(groups[family] ||= []).push({ name: n, mod });
		});
		const familyRank = (f) => {
			const i = TOKEN_FAMILY_ORDER.indexOf(f);
			return i < 0 ? TOKEN_FAMILY_ORDER.length + 1 : i;
		};
		const modRank = (mod) =>
			mod in TOKEN_MOD_RANK ? TOKEN_MOD_RANK[mod] : (mod.startsWith("trans") ? 8 + parseInt(mod.split("-")[1] || 0, 10) / 100 : 9);
		return Object.keys(groups)
			.sort((a, b) => (familyRank(a) - familyRank(b)) || a.localeCompare(b))
			.map((family) => ({
				family,
				rows: groups[family].sort((a, b) => modRank(a.mod) - modRank(b.mod)).map((x) => x.name),
			}));
	}

	/* ================================================================== */
	/* iframe-Zugriff                                                      */
	/* ================================================================== */

	function iframeDocs() {
		const docs = [];
		const scan = (doc) => {
			doc.querySelectorAll("iframe").forEach((f) => {
				try {
					if (f.contentDocument) {
						docs.push(f.contentDocument);
						scan(f.contentDocument);
					}
				} catch (_) { /* cross-origin */ }
			});
		};
		scan(document);
		return docs;
	}

	/* ================================================================== */
	/* Haupt-UI                                                            */
	/* ================================================================== */

	function buildUi(etch) {
		/* Schutz gegen doppelt geladene Instanzen (z. B. alte Plugin-Kopie) */
		if (window.__eppeActive) {
			log("Second instance skipped (active: v" + window.__eppeActive + "). Please keep only ONE plugin copy active.");
			return;
		}
		window.__eppeActive = VERSION;
		document.querySelectorAll(".eppe-panel, .eppe-launcher, .eppe-tooltip, .eppe-convert-notice, #eppe-styles").forEach((n) => n.remove());

		injectTopStyles();

		/* ---------------------------------------------------------------- */
		/* Persistence                                                       */
		/* ---------------------------------------------------------------- */

		async function persistGb(blockId, htmlContent) {
			const fresh = etch.blocks.getJson(blockId);
			const gb = fresh.gutenbergBlock;
			const outer = parseOuter(gb.innerHTML);
			if (!outer) throw new Error("innerHTML not parsable");
			const clone = outer.cloneNode(false);
			clone.innerHTML = htmlContent;
			sanitizeEditorHtml(clone);
			const newHtml = clone.outerHTML;

			const newInnerContent = (gb.innerContent && gb.innerContent.length
				? gb.innerContent
				: [gb.innerHTML]
			).map((s) => (typeof s === "string" ? newHtml : s));

			const authoring = toAuthoring(fresh);
			authoring.gutenbergBlock = { ...gb, innerHTML: newHtml, innerContent: newInnerContent };

			const newId = etch.blocks.replace(blockId, authoring);
			await etch.saveAsync();
			return newId;
		}

		/** Save a nested text block inside a container passthrough.
		    Only the affected inner block is changed; the container wrapper
		    (innerContent with the null placeholders) is left untouched. */
		async function persistGbNested(passthroughId, path, htmlContent) {
			const fresh = etch.blocks.getJson(passthroughId);
			const gb = JSON.parse(JSON.stringify(fresh.gutenbergBlock)); // deep copy
			const target = nestedBlockAt(gb, path);
			if (!target) throw new Error("Nested block not found.");

			const outer = parseOuter(target.innerHTML);
			if (!outer) throw new Error("innerHTML not parsable");
			const clone = outer.cloneNode(false);
			clone.innerHTML = htmlContent;
			sanitizeEditorHtml(clone);
			const newOuterHtml = clone.outerHTML;

			/* Preserve whitespace around the tag (e.g. "\n<p>…</p>\n") */
			const newInnerHTML = target.innerHTML.includes(outer.outerHTML)
				? target.innerHTML.replace(outer.outerHTML, newOuterHtml)
				: newOuterHtml;
			target.innerHTML = newInnerHTML;
			target.innerContent = (target.innerContent && target.innerContent.length
				? target.innerContent
				: [target.innerHTML]
			).map((s) => (typeof s === "string" ? newInnerHTML : s));

			const authoring = toAuthoring(fresh);
			authoring.gutenbergBlock = gb;

			const newId = etch.blocks.replace(passthroughId, authoring);
			await etch.saveAsync();
			return newId;
		}

		async function persistEtch(blockId, htmlContent) {
			const fresh = etch.blocks.getJson(blockId);
			const container = document.createElement("div");
			container.innerHTML = htmlContent;
			sanitizeEditorHtml(container);

			const tpls = findTemplates(etch);
			const newChildren = htmlToChildren(container, tpls);

			const authoring = toAuthoring(fresh);
			authoring.children = newChildren;
			log("persistEtch – Authoring-JSON:", JSON.parse(JSON.stringify(authoring)));

			const newId = etch.blocks.replace(blockId, authoring);
			await etch.saveAsync();
			return newId;
		}

		/* ---------------------------------------------------------------- */
		/* Canvas styles (per iframe document)                               */
		/* ---------------------------------------------------------------- */

		const CANVAS_CSS = `
		.eppe-tb, .eppe-tb * {
			font-family: var(--e-font-interface, Inter, system-ui, sans-serif) !important;
		}
		.eppe-tb {
			position: fixed; z-index: 2147483647; display: flex; flex-wrap: wrap;
			gap: 3px; align-items: center; padding: 5px 6px;
			background: #1e1e24; border: 1px solid #3a3a44; border-radius: 8px;
			box-shadow: 0 4px 20px rgba(0,0,0,.45);
			font: 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif); pointer-events: auto;
		}
		.eppe-tb button {
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 5px; padding: 5px 8px; cursor: pointer;
			font: 600 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif); min-width: 26px;
			pointer-events: auto;
		}
		.eppe-tb .eppe-icon-btn {
			display: inline-flex; align-items: center; justify-content: center;
			width: 34px; min-width: 34px; height: 26px; padding: 3px 6px;
		}
		.eppe-tb .eppe-icon {
			display: block; width: 18px; height: 18px; flex: none;
		}
		.eppe-tb button:hover { background: #3a3a46; }
		.eppe-tb .eppe-tb-i { font-style: italic; font-weight: 400; }
		.eppe-tb .eppe-tb-color {
			display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 5px; padding: 4px 6px; font: 600 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif);
		}
		.eppe-tb .eppe-tb-color:hover { background: #3a3a46; }
		.eppe-tb .eppe-tb-color input {
			width: 18px; height: 16px; padding: 0; border: none; background: none; cursor: pointer;
		}
		.eppe-tb select {
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 5px; padding: 4px 4px; font-size: 11px; cursor: pointer;
			pointer-events: auto;
		}
		.eppe-tb .eppe-tb-save { background: #7c3aed; color: #fff; border-color: #7c3aed; }
		.eppe-tb .eppe-tb-save:hover { background: #6d28d9; }
		.eppe-tb .eppe-tb-cancel { color: #a1a1ab; }
		.eppe-tb .eppe-tb-sep { width: 1px; height: 18px; background: #3a3a44; margin: 0 2px; }
		.eppe-tb-linkrow { display: none; position: relative; width: 100%; gap: 4px; padding-top: 5px; }
		.eppe-tb-linkrow input {
			flex: 1; background: #17171c; color: #f4f4f6; border: 1px solid #3a3a44;
			border-radius: 5px; padding: 5px 7px; font-size: 11px; outline: none; min-width: 180px;
			pointer-events: auto;
		}
		.eppe-tb-results {
			display: none; position: absolute; left: 0; right: 0; top: 100%; margin-top: 3px;
			background: #1e1e24; border: 1px solid #3a3a44; border-radius: 6px;
			max-height: 200px; overflow: auto; z-index: 1; box-shadow: 0 6px 20px rgba(0,0,0,.5);
		}
		.eppe-tb-results.open { display: block; }
		.eppe-tb-result {
			padding: 6px 9px; cursor: pointer; font-size: 12px; color: #e5e5ea;
			border-bottom: 1px solid #2a2a32; display: flex; justify-content: space-between; gap: 8px;
		}
		.eppe-tb-result:last-child { border-bottom: none; }
		.eppe-tb-result:hover, .eppe-tb-result.active { background: #7c3aed; color: #fff; }
		.eppe-tb-result .eppe-tb-rtype { font-size: 10px; opacity: .6; text-transform: uppercase; }
		.eppe-tb-result .eppe-tb-rtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.eppe-tb-result.eppe-tb-empty { color: #a1a1ab; cursor: default; }
		.eppe-tb-result.eppe-tb-empty:hover { background: #1e1e24; color: #a1a1ab; }
		.eppe-toast {
			position: fixed; z-index: 2147483647; padding: 7px 12px;
			background: #1e1e24; color: #34d399; border: 1px solid #3a3a44;
			border-radius: 7px; font: 600 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif);
			box-shadow: 0 4px 16px rgba(0,0,0,.4);
		}
		.eppe-toast.error { color: #f87171; }
		.eppe-editbtn {
			position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 7px;
			background: #7c3aed; color: #fff; border: none; border-radius: 8px;
			padding: 9px 16px; font: 600 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif) !important; cursor: pointer;
			font-family: var(--e-font-interface, Inter, system-ui, sans-serif) !important;
			box-shadow: 0 4px 16px rgba(0,0,0,.45); pointer-events: auto;
		}
		.eppe-editbtn:hover { background: #6d28d9; }
		[data-eppe-editing="1"] {
			outline: 2px solid #7c3aed !important; outline-offset: 3px;
			border-radius: 2px; cursor: text;
		}
		[data-eppe-content] { cursor: pointer; }
		[data-eppe-content]:hover { outline: 1px dashed rgba(124,58,237,.6); outline-offset: 3px; }
		`;

		function ensureCanvasStyles(doc) {
			if (doc.getElementById("eppe-canvas-styles")) return;
			const style = doc.createElement("style");
			style.id = "eppe-canvas-styles";
			style.textContent = CANVAS_CSS;
			(doc.head || doc.documentElement).appendChild(style);
		}

		function toast(doc, msg, isError) {
			const t = doc.createElement("div");
			t.className = "eppe-toast" + (isError ? " error" : "");
			t.textContent = msg;
			t.style.left = "20px";
			t.style.bottom = "20px";
			doc.body.appendChild(t);
			setTimeout(() => t.remove(), isError ? 4000 : 2000);
		}

		/** Run the action on mousedown – the click phase is neutralized
		 *  so Etch's canvas handlers and focus changes don't interfere. */
		function onTap(btn, fn) {
			btn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				fn();
			}, true);
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
			}, true);
		}

		/* ---------------------------------------------------------------- */
		/* Canvas-Editor-Session                                             */
		/* ---------------------------------------------------------------- */

		let session = null;
		let activeMirrorEl = null; // canvas node currently mirrored live by the popup
		let lastSelected = false; // sentinel: forces re-evaluation in the poll

		function buildToolbar(doc) {
			ensureCanvasStyles(doc);
			const tb = doc.createElement("div");
			tb.className = "eppe-tb";
			tb.innerHTML = `
				<button data-cmd="bold" title="Bold (strong)">B</button>
				<button data-cmd="italic" title="Italic (em)" class="eppe-tb-i">I</button>
				<button data-cmd="superscript" title="Superscript">x&sup2;</button>
				<button data-cmd="subscript" title="Subscript">x&#8322;</button>
				<select class="eppe-tb-weight" title="font-weight">
					<option value="">Weight</option>
					<option value="300">300</option><option value="400">400</option>
					<option value="500">500</option><option value="600">600</option>
					<option value="700">700</option><option value="800">800</option>
				</select>
				<label class="eppe-tb-color" title="Text color">A<input type="color" value="#000000" /></label>
				<button class="eppe-tb-link eppe-icon-btn" title="Add link" aria-label="Add link">${LINK_ICON_SVG}</button>
				<button class="eppe-icon-btn" data-cmd="unlink" title="Remove link" aria-label="Remove link">${UNLINK_ICON_SVG}</button>
				<button class="eppe-tb-clear" title="Clear formatting">T&#8339;</button>
				<span class="eppe-tb-sep"></span>
				<button class="eppe-tb-cancel" title="Discard (Esc) – clicking outside saves automatically">&#10005;</button>
				<div class="eppe-tb-linkrow">
					<input type="text" placeholder="https://… or search pages, posts &amp; media" autocomplete="off" />
					<button class="eppe-tb-linkset">Apply</button>
					<div class="eppe-tb-results"></div>
				</div>
			`;
			doc.body.appendChild(tb);
			return tb;
		}

		function positionToolbar() {
			if (!session) return;
			const { el, toolbar, win } = session;
			if (!el.isConnected) return;
			const r = el.getBoundingClientRect();
			const tbH = toolbar.offsetHeight || 40;
			/* prefer BELOW the element – Etch's own selection label sits above it */
			let top = r.bottom + 10;
			if (top + tbH > (win.innerHeight || 600) - 8) top = Math.max(4, r.top - tbH - 10);
			toolbar.style.top = top + "px";
			toolbar.style.left =
				Math.max(4, Math.min(r.left, (win.innerWidth || 800) - toolbar.offsetWidth - 8)) + "px";
		}

		function endSession(restore) {
			if (!session) return;
			const s = session;
			session = null;
			lastSelected = false; // Poll soll Edit-Button neu anbieten
			try {
				if (restore && s.el.isConnected) s.el.innerHTML = s.originalHtml;
				s.el.removeAttribute("contenteditable");
				s.el.removeAttribute("data-eppe-editing");
			} catch (_) { /* best-effort */ }
			try { s.toolbar.remove(); } catch (_) { /* best-effort */ }
			s.cleanup.forEach((fn) => {
				try { fn(); } catch (_) { /* best-effort */ }
			});
		}

		async function saveSession() {
			if (!session || session.saving) return;
			const s = session;
			s.saving = true; // prevent double save (outside click + auto-save)
			try {
				if (!s.el.isConnected) throw new Error("The element was re-rendered by the builder – please reopen it.");
				const blockId = s.resolveBlockId();
				if (!blockId) throw new Error("Block could not be found.");
				const html = s.el.innerHTML;
				if (s.mode === "gb") await persistGb(blockId, html);
				else await persistEtch(blockId, html);
				const doc = s.doc;
				endSession(false);
				toast(doc, s.mode === "gb" ? "Saved ✓ (synced with Gutenberg)" : "Saved ✓");
				refreshPreviewBurst();
			} catch (e) {
				err("Saving failed:", apiErrInfo(e));
				toast(s.doc, "Error: " + apiErrInfo(e), true);
				s.saving = false;
			}
		}

		/**
		 * Commit the edit into the Etch model immediately (→ the HTML panel
		 * updates at once) and reopen the inline editing seamlessly.
		 * Intended for discrete actions like Unlink/Clear (not while typing).
		 */
		async function commitLive() {
			if (!session || session.saving) return;
			const s = session;
			s.saving = true;
			try {
				if (!s.el.isConnected) { s.saving = false; return; }
				const blockId = s.resolveBlockId();
				if (!blockId) { s.saving = false; return; }
				const mode = s.mode;
				const html = s.el.innerHTML;
				const newId = mode === "gb"
					? await persistGb(blockId, html)
					: await persistEtch(blockId, html);

				endSession(false); // end the current (now stale) session

				/* After the re-render, find the new node and resume
				   editing – several attempts, since the canvas re-renders
				   asynchronously. */
				const reopen = (tries) => {
					let node = null;
					try {
						const fresh = etch.blocks.getJson(newId);
						node = mode === "etch"
							? findCanvasNodeForEtch(fresh)
							: findPreviewNodeForGb(fresh);
					} catch (_) { /* not ready yet */ }
					if (node) {
						if (mode === "gb") startGbSessionFromPreview(node);
						else startSession("etch", node, () => newId);
					} else if (tries > 0) {
						setTimeout(() => reopen(tries - 1), 150);
					}
				};
				setTimeout(() => reopen(12), 150);
			} catch (e) {
				err("Live commit failed:", apiErrInfo(e));
				if (session) session.saving = false;
			}
		}

		function startSession(mode, el, resolveBlockId) {
			endSession(true);
			hideEditBtn();

			const doc = el.ownerDocument;
			const win = doc.defaultView;
			ensureCanvasStyles(doc);

			const toolbar = buildToolbar(doc);
			const cleanup = [];

			stripEmptyInline(el); // remove invisible empty inline leftovers before editing

			/* Adopt a text selection already made in the canvas before opening */
			let preRange = null;
			try {
				const preSel = win.getSelection();
				if (preSel && preSel.rangeCount) {
					const r = preSel.getRangeAt(0);
					if (!r.collapsed && el.contains(r.commonAncestorContainer)) {
						preRange = r.cloneRange();
					}
				}
			} catch (_) { /* ignore */ }

			session = {
				mode, el, doc, win, toolbar, resolveBlockId, cleanup,
				originalHtml: el.innerHTML,
				savedRange: preRange,
			};

			el.setAttribute("contenteditable", "true");
			el.setAttribute("data-eppe-editing", "1");
			el.focus();

			/* Restore the selection after focusing (focus collapses it otherwise) */
			if (preRange) {
				try {
					const sel = win.getSelection();
					sel.removeAllRanges();
					sel.addRange(preRange);
				} catch (_) { /* ignore */ }
			}

			/* Keep Etch's canvas handlers away from the edited element */
			const stop = (e) => e.stopPropagation();
			["mousedown", "mouseup", "click", "dblclick", "keydown", "keypress", "keyup", "input", "paste"].forEach((t) => {
				el.addEventListener(t, stop, true);
				cleanup.push(() => el.removeEventListener(t, stop, true));
			});

			/* Paste always as plain text (strip Word/Pages formatting) */
			const onPaste = (e) => handlePlainPaste(e, doc);
			el.addEventListener("paste", onPaste, true);
			cleanup.push(() => el.removeEventListener("paste", onPaste, true));

			/* Don't let toolbar events leak to Etch (bubble phase) */
			["mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "input", "paste"].forEach((t) => {
				toolbar.addEventListener(t, stop, false);
			});

			const onKey = (e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					endSession(true);
				} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					saveSession();
				}
			};
			el.addEventListener("keydown", onKey, true);
			cleanup.push(() => el.removeEventListener("keydown", onKey, true));

			/* Click outside the edited paragraph: automatically save the
			   session (if changed) and, if applicable, switch directly into
			   the clicked text paragraph – like in a normal editor. */
			const onDocDown = (e) => {
				try {
					if (!session || session.el !== el) return;
					const t = e.target;
					if (!t || !t.closest) return;
					if (el.contains(t) || t.closest(".eppe-tb") || t.closest(".eppe-editbtn")) return;

					const changed = el.innerHTML !== session.originalHtml;
					const container =
						!t.closest("[data-eppe-preview]") && t.closest(ETCH_TEXT_TAGS.join(","));

					const maybeSwitch = () => {
						if (!container) return;
						const block = findEtchBlockForNode(container);
						if (block) startSession("etch", container, () => block.id);
					};

					if (changed) {
						saveSession().then(maybeSwitch);
					} else {
						endSession(false);
						maybeSwitch();
					}
				} catch (_) { /* never disturb Etch */ }
			};
			doc.addEventListener("mousedown", onDocDown, true);
			cleanup.push(() => doc.removeEventListener("mousedown", onDocDown, true));

			const onSelChange = () => {
				if (!session) return;
				const sel = win.getSelection();
				if (sel.rangeCount && el.contains(sel.anchorNode)) {
					session.savedRange = sel.getRangeAt(0).cloneRange();
				}
				positionToolbar();
			};
			doc.addEventListener("selectionchange", onSelChange);
			cleanup.push(() => doc.removeEventListener("selectionchange", onSelChange));

			const onScroll = () => positionToolbar();
			win.addEventListener("scroll", onScroll, true);
			win.addEventListener("resize", onScroll);
			cleanup.push(() => {
				win.removeEventListener("scroll", onScroll, true);
				win.removeEventListener("resize", onScroll);
			});

			const restoreRange = () => {
				if (!session || !session.savedRange) return false;
				const sel = win.getSelection();
				sel.removeAllRanges();
				sel.addRange(session.savedRange);
				return true;
			};

			/* --- Buttons (alle auf mousedown) --- */

			/* Inline-Tags im markierten Bereich auspacken (sofort sichtbar).
			   Ohne Markierung: den ganzen Absatz. tagsCsv z. B. "a" oder
			   "strong,em,span,…". */
			const unwrapInScope = (tagsCsv) => {
				const sel = win.getSelection();
				const scopeAll = !sel.rangeCount || sel.isCollapsed || !el.contains(sel.anchorNode);
				el.querySelectorAll(tagsCsv).forEach((n) => {
					if (scopeAll || (sel.containsNode && sel.containsNode(n, true))) {
						while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
						n.remove();
					}
				});
				stripEmptyInline(el);
				el.normalize();
			};

			toolbar.querySelectorAll("[data-cmd]").forEach((btn) => {
				onTap(btn, () => {
					el.focus();
					restoreRange();
					if (btn.dataset.cmd === "unlink") {
						/* execCommand("unlink") only works with a real selection –
						   direct DOM manipulation is immediately visible */
						unwrapInScope("a");
						onSelChange();
						commitLive(); // apply to the Etch model / HTML panel immediately
						return;
					}
					doc.execCommand(btn.dataset.cmd, false, null);
					onSelChange();
				});
			});

			/* Wrap the selected range in a span with a style property
			   (font-weight, color, …) – immediately visible */
			const applySpanStyle = (prop, value) => {
				if (!session.savedRange || session.savedRange.collapsed) {
					toast(doc, "Please select some text first.", true);
					return;
				}
				el.focus();
				restoreRange();
				const sel = win.getSelection();
				if (sel.isCollapsed) { toast(doc, "Please select some text first.", true); return; }
				const range = sel.getRangeAt(0);
				const span = doc.createElement("span");
				span.style[prop] = value;
				try {
					range.surroundContents(span);
				} catch (_) {
					span.appendChild(range.extractContents());
					range.insertNode(span);
				}
				onSelChange();
			};

			const weightSel = toolbar.querySelector(".eppe-tb-weight");
			weightSel.addEventListener("mousedown", (e) => e.stopPropagation());
			weightSel.addEventListener("change", (e) => {
				const weight = e.target.value;
				e.target.value = "";
				if (weight) applySpanStyle("fontWeight", weight);
			});

			const colorInput = toolbar.querySelector(".eppe-tb-color input");
			colorInput.addEventListener("mousedown", (e) => e.stopPropagation());
			colorInput.addEventListener("input", (e) => applySpanStyle("color", e.target.value));

			const linkRow = toolbar.querySelector(".eppe-tb-linkrow");
			const linkInput = linkRow.querySelector("input");
			const linkResults = linkRow.querySelector(".eppe-tb-results");

			onTap(toolbar.querySelector(".eppe-tb-link"), () => {
				if (!session.savedRange || session.savedRange.collapsed) {
					toast(doc, "Please select the text you want to link first.", true);
					return;
				}
				linkRow.style.display = "flex";
				linkInput.value = "";
				linkResults.className = "eppe-tb-results";
				linkResults.innerHTML = "";
				positionToolbar();
				setTimeout(() => linkInput.focus(), 0);
			});

			const applyLink = () => {
				const url = linkInput.value.trim();
				if (!url) return;
				el.focus();
				if (!restoreRange()) { toast(doc, "Selection lost – please select the text again.", true); return; }
				doc.execCommand("createLink", false, url);
				linkRow.style.display = "none";
				linkResults.className = "eppe-tb-results";
				positionToolbar();
			};
			onTap(linkRow.querySelector(".eppe-tb-linkset"), applyLink);
			linkInput.addEventListener("mousedown", (e) => e.stopPropagation());

			/* --- interne Seiten-/Beitragssuche --- */
			let searchTimer = null;
			let activeIdx = -1;

			const renderResults = (items) => {
				activeIdx = -1;
				if (!items) { linkResults.className = "eppe-tb-results"; linkResults.innerHTML = ""; return; }
				if (!items.length) {
					linkResults.innerHTML = `<div class="eppe-tb-result eppe-tb-empty">No matches</div>`;
					linkResults.className = "eppe-tb-results open";
					return;
				}
				linkResults.innerHTML = items.map((it) =>
					`<div class="eppe-tb-result" data-url="${escapeAttr(it.url)}">` +
					`<span class="eppe-tb-rtitle">${escapeHtml(it.title || it.url)}</span>` +
					`<span class="eppe-tb-rtype">${escapeHtml(it.type)}</span></div>`
				).join("");
				linkResults.className = "eppe-tb-results open";
				linkResults.querySelectorAll(".eppe-tb-result").forEach((row) => {
					row.addEventListener("mousedown", (e) => {
						e.preventDefault();
						e.stopPropagation();
						const u = row.getAttribute("data-url");
						if (u) { linkInput.value = u; applyLink(); }
					}, true);
				});
			};

			const doSearch = (q) => {
				clearTimeout(searchTimer);
				if (/^https?:\/\//i.test(q) || q.startsWith("/") || q.startsWith("#") || q.startsWith("mailto:")) {
					renderResults(null); return; // looks like a real URL → don't search
				}
				if (q.length < 2) { renderResults(null); return; }
				searchTimer = setTimeout(async () => {
					try {
						renderResults(await searchInternal(q));
					} catch (e) {
						log("Internal search failed:", String(e));
						renderResults(null);
					}
				}, 250);
			};

			linkInput.addEventListener("input", () => doSearch(linkInput.value.trim()));
			linkInput.addEventListener("keydown", (e) => {
				e.stopPropagation();
				const rows = Array.from(linkResults.querySelectorAll(".eppe-tb-result:not(.eppe-tb-empty)"));
				if (e.key === "ArrowDown" && rows.length) {
					e.preventDefault();
					activeIdx = Math.min(activeIdx + 1, rows.length - 1);
					rows.forEach((r, i) => r.classList.toggle("active", i === activeIdx));
				} else if (e.key === "ArrowUp" && rows.length) {
					e.preventDefault();
					activeIdx = Math.max(activeIdx - 1, 0);
					rows.forEach((r, i) => r.classList.toggle("active", i === activeIdx));
				} else if (e.key === "Enter") {
					e.preventDefault();
					if (activeIdx >= 0 && rows[activeIdx]) {
						linkInput.value = rows[activeIdx].getAttribute("data-url");
					}
					applyLink();
				} else if (e.key === "Escape") {
					if (linkResults.classList.contains("open")) {
						renderResults(null);
					} else {
						linkRow.style.display = "none"; positionToolbar();
					}
				}
			});

			onTap(toolbar.querySelector(".eppe-tb-clear"), () => {
				el.focus();
				restoreRange();
				doc.execCommand("removeFormat", false, null);
				/* Alle Inline-Formatierungen sofort sichtbar auspacken */
				unwrapInScope("span,strong,em,a,u,s,mark,code,sub,sup");
				onSelChange();
				commitLive(); // apply to the Etch model / HTML panel immediately
			});

			onTap(toolbar.querySelector(".eppe-tb-cancel"), () => endSession(true));

			/* Click into the builder UI (top window) while editing:
			   also auto-save or close */
			const onTopDown = () => {
				if (!session || session.el !== el || session.saving) return;
				const changed = el.innerHTML !== session.originalHtml;
				if (changed) saveSession();
				else endSession(false);
			};
			document.addEventListener("mousedown", onTopDown, true);
			cleanup.push(() => document.removeEventListener("mousedown", onTopDown, true));

			positionToolbar();
			setTimeout(positionToolbar, 50);
		}

		/* ---------------------------------------------------------------- */
		/* Edit button next to Etch's blue selection label                   */
		/* ---------------------------------------------------------------- */

		let editBtn = null; // { btn, doc, node, target }

		function hideEditBtn() {
			if (editBtn) {
				try { editBtn.btn.remove(); } catch (_) { /* best-effort */ }
				editBtn = null;
			}
		}

		function findEtchSelectionLabel(doc, node, nodeRect) {
			const labelPattern = /^.+\s+[—-]\s+\d+\s*[×x]\s*\d+$/;
			const candidates = [];
			doc.body.querySelectorAll("*").forEach((el) => {
				if (el === node || el.contains(node) || node.contains(el)) return;
				if (el.closest(".eppe-editbtn, .eppe-tb, [data-eppe-preview]")) return;
				if (!labelPattern.test(normText(el.textContent))) return;
				const rect = el.getBoundingClientRect();
				if (!rect.width || !rect.height) return;
				if (Math.abs(rect.bottom - nodeRect.top) > 14) return;
				if (Math.abs(rect.left - nodeRect.left) > 28) return;
				candidates.push({ el, rect, area: rect.width * rect.height });
			});
			candidates.sort((a, b) => a.area - b.area);
			return candidates.length ? candidates[0].el : null;
		}

		function positionEditBtn() {
			if (!editBtn) return;
			const { btn, node, doc } = editBtn;
			if (!node.isConnected) { hideEditBtn(); return; }
			const r = node.getBoundingClientRect();
			const h = btn.offsetHeight || 26;
			const w = btn.offsetWidth || 100;
			const win = doc.defaultView;
			const label = editBtn.label && editBtn.label.isConnected
				? editBtn.label
				: findEtchSelectionLabel(doc, node, r);
			if (label) editBtn.label = label;
			const labelRect = label ? label.getBoundingClientRect() : null;
			let top = labelRect
				? labelRect.top + (labelRect.height - h) / 2
				: r.top - h - 6;
			if (top < 4) top = r.bottom + 6;
			const preferredLeft = labelRect ? labelRect.right + 8 : r.left + 180;
			btn.style.top = top + "px";
			btn.style.left = Math.max(4, Math.min(preferredLeft, (win.innerWidth || 800) - w - 8)) + "px";
		}

		function showEditBtn(node, target) {
			if (editBtn && editBtn.node !== node) hideEditBtn();
			if (!editBtn) {
				const doc = node.ownerDocument;
				ensureCanvasStyles(doc);
				const btn = doc.createElement("button");
				btn.className = "eppe-editbtn";
				btn.innerHTML = "&#9998; Edit";
				onTap(btn, () => {
					/* Toggle: a second click on the edit button closes the popup */
					if (popup.isOpen()) { popup.saveOrClose(); return; }
					const t = editBtn && editBtn.target;
					const n = editBtn && editBtn.node;
					hideEditBtn();
					if (!t) return;
					/* Edit uniformly through the popup (more robust than inline).
					   Pass the canvas node for live preview: the <p> for Etch,
					   the preview's content element for GB. */
					popup.open({ ...t, mirrorEl: n || null });
				});
				doc.body.appendChild(btn);
				editBtn = { btn, doc, node, target, label: null };
			}
			editBtn.target = target;
			positionEditBtn();
		}

		/* ---------------------------------------------------------------- */
		/* Canvas preview for Gutenberg blocks                               */
		/* ---------------------------------------------------------------- */

		function injectPreview(el, block, label) {
			const gb = block.gutenbergBlock;
			const outer = parseOuter(gb.innerHTML);
			if (!outer || !outer.textContent.trim()) return;

			const doc = el.ownerDocument;
			ensureCanvasStyles(doc);

			const content = doc.createElement("span");
			content.innerHTML = outer.innerHTML;
			sanitizeEditorHtml(content);
			content.setAttribute("data-eppe-content", "1");
			content.setAttribute("data-eppe-label", label);
			content.title = "Click to edit (Gutenberg block)";

			el.innerHTML = "";
			const badge = doc.createElement("span");
			badge.textContent = "GB";
			badge.style.cssText =
				"display:inline-block;font:700 9px/1.4 var(--e-font-interface, Inter, system-ui, sans-serif);color:#7c3aed;" +
				"border:1px solid #7c3aed;border-radius:4px;padding:1px 4px;margin-right:8px;" +
				"vertical-align:middle;letter-spacing:.5px;";
			el.appendChild(badge);
			el.appendChild(content);

			el.style.textTransform = "none";
			el.style.letterSpacing = "normal";
			el.style.textAlign = "left";
			el.style.opacity = "1";
			el.style.color = "inherit";
			el.setAttribute("data-eppe-preview", "1");
			el.style.backgroundImage = "none";
			el.style.backgroundColor = GB_PREVIEW_HIGHLIGHT;

			content.addEventListener("mousedown", (e) => e.stopPropagation(), true);
			content.addEventListener("click", (e) => {
				e.stopPropagation();
				e.preventDefault();
				const block = resolveGbBlockForPreview(content);
				if (block && isEditableGb(block)) popup.open({ mode: "gb", block, mirrorEl: content });
			}, true);
		}

		/** Preview for container passthroughs (core/group, core/columns, …):
		    shows each nested text block as its own clickable line.
		    editing happens via the popup (mode "gbnested"). */
		function injectContainerPreview(el, block, label) {
			const nested = collectNestedEditable(block.gutenbergBlock);
			if (!nested.length) return;

			/* Signature to avoid unnecessary rebuilds (flicker) */
			const sig = nested.map((n) => n.path.join(".") + ":" + n.innerHTML).join("||");
			if (el.getAttribute("data-eppe-sig") === sig && el.getAttribute("data-eppe-preview") === "1") return;

			const doc = el.ownerDocument;
			ensureCanvasStyles(doc);

			el.innerHTML = "";
			const badge = doc.createElement("span");
			badge.textContent = "GB " + label.replace(/^core\//, "");
			badge.style.cssText =
				"display:inline-block;font:700 9px/1.4 var(--e-font-interface, Inter, system-ui, sans-serif);color:#7c3aed;" +
				"border:1px solid #7c3aed;border-radius:4px;padding:1px 4px;margin-right:8px;" +
				"vertical-align:middle;letter-spacing:.5px;";
			el.appendChild(badge);

			nested.forEach((n) => {
				const outer = parseOuter(n.innerHTML);
				const line = doc.createElement("div");
				line.className = "eppe-nested-line";
				line.setAttribute("data-eppe-path", n.path.join("."));
				line.innerHTML = outer ? outer.innerHTML : "";
				sanitizeEditorHtml(line);
				line.title = "Click to edit (Gutenberg block in " + label + ")";
				line.style.cssText = "cursor:pointer;padding:2px 4px;border-radius:3px;margin:1px 0;";
				line.addEventListener("mouseenter", () => { line.style.outline = "1px dashed rgba(124,58,237,.6)"; });
				line.addEventListener("mouseleave", () => { line.style.outline = "none"; });
				line.addEventListener("mousedown", (e) => e.stopPropagation(), true);
				line.addEventListener("click", (e) => {
					e.stopPropagation();
					e.preventDefault();
					openNestedPopup(el, n.path, label, line);
				}, true);
				el.appendChild(line);
			});

			el.style.textTransform = "none";
			el.style.letterSpacing = "normal";
			el.style.textAlign = "left";
			el.style.opacity = "1";
			el.style.color = "inherit";
			el.setAttribute("data-eppe-preview", "1");
			el.setAttribute("data-eppe-container", label);
			el.setAttribute("data-eppe-sig", sig);
			el.style.backgroundImage = "none";
			el.style.backgroundColor = GB_PREVIEW_HIGHLIGHT;
		}

		const GB_PREVIEW_HIGHLIGHT = "rgba(124,58,237,.05)";
		const GB_SECTION_ATTR = "data-eppe-gb-section";

		/**
		 * Highlight only the Gutenberg passthrough preview itself. Also clean up
		 * the previous 1.0.5 parent-section highlight if the script is updated
		 * without a full canvas reload.
		 */
		function syncGbPreviewHighlights(doc) {
			doc.querySelectorAll("[data-eppe-preview]").forEach((preview) => {
				preview.style.backgroundImage = "none";
				preview.style.backgroundColor = GB_PREVIEW_HIGHLIGHT;
			});

			doc.querySelectorAll(`[${GB_SECTION_ATTR}]`).forEach((section) => {
				section.style.backgroundColor = section.__eppePreviousBackgroundColor || "";
				delete section.__eppePreviousBackgroundColor;
				section.removeAttribute(GB_SECTION_ATTR);
			});
		}

		/** Resolve a container passthrough by label + position index
		    (robust against id changes after saving) */
		function resolveContainerBlock(previewEl, label) {
			const doc = previewEl.ownerDocument;
			const peers = Array.from(doc.querySelectorAll(`[data-eppe-container="${label}"]`));
			const idx = Math.max(0, peers.indexOf(previewEl));
			const blocks = collectPassthroughs(etch).filter(
				(b) => (b.gutenbergBlock.blockName || "").toLowerCase() === label && isContainerPassthrough(b)
			);
			return blocks[idx] || blocks[0] || null;
		}

		/** Open the popup for a nested text block */
		function openNestedPopup(previewEl, path, label, mirrorEl) {
			const block = resolveContainerBlock(previewEl, label);
			if (!block) { toast(previewEl.ownerDocument, "Container block not found.", true); return; }
			const target = nestedBlockAt(block.gutenbergBlock, path);
			if (!target) { toast(previewEl.ownerDocument, "Nested block not found.", true); return; }
			popup.open({
				mode: "gbnested",
				passthroughId: block.id,
				path,
				blockName: target.blockName,
				innerHTML: target.innerHTML,
				containerLabel: label,
				mirrorEl: mirrorEl || null,
			});
		}

		function resolveGbBlockForPreview(content) {
			const label = content.getAttribute("data-eppe-label");
			const doc = content.ownerDocument;
			const siblings = Array.from(doc.querySelectorAll(`[data-eppe-content][data-eppe-label="${label}"]`));
			const idx = siblings.indexOf(content);
			if (idx < 0) return null;
			const blocks = collectPassthroughs(etch).filter(
				(b) => (b.gutenbergBlock.blockName || "").toLowerCase() === label
			);
			return blocks[idx] || null;
		}

		function findPreviewNodeForGb(block) {
			const label = (block.gutenbergBlock.blockName || "").toLowerCase();
			const sameLabel = collectPassthroughs(etch).filter(
				(b) => (b.gutenbergBlock.blockName || "").toLowerCase() === label
			);
			const idx = sameLabel.findIndex((b) => b.id === block.id);
			if (idx < 0) return null;
			for (const doc of iframeDocs()) {
				const list = doc.querySelectorAll(`[data-eppe-content][data-eppe-label="${label}"]`);
				if (list[idx]) return list[idx];
			}
			return null;
		}

		function startGbSessionFromPreview(content) {
			const block = resolveGbBlockForPreview(content);
			if (!block || !isEditableGb(block)) {
				toast(content.ownerDocument, "Block is not editable or could not be found.", true);
				return;
			}
			const outer = parseOuter(block.gutenbergBlock.innerHTML);
			if (outer) {
				content.innerHTML = outer.innerHTML;
				sanitizeEditorHtml(content);
			}
			startSession("gb", content, () => {
				const fresh = resolveGbBlockForPreview(content);
				return fresh ? fresh.id : null;
			});
		}

		function runPreviewScan() {
			void runBackgroundRepairs().then(() => refreshConversionNotice()).catch(() => { /* optional */ });
			const blocks = collectPassthroughs(etch);

			const byLabel = {};
			blocks.forEach((b) => {
				const key = (b.gutenbergBlock.blockName || "").toLowerCase();
				(byLabel[key] ||= []).push(b);
			});

			for (const doc of iframeDocs()) {
				if (!doc.body) continue;

				/* 1) Add previews to new placeholders */
				const counters = {};
				doc.body.querySelectorAll("*:not([data-eppe-preview])").forEach((el) => {
					if (el.children.length) return;
					if (el.closest("[data-eppe-preview]")) return;
					const t = normText(el.textContent).toLowerCase();
					if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(t)) return;
					const list = byLabel[t];
					if (!list) return;
					const idx = (counters[t] = counters[t] ?? 0);
					counters[t]++;
					const block = list[idx];
					if (!block) return;
					try {
						if (isContainerPassthrough(block)) injectContainerPreview(el, block, t);
						else injectPreview(el, block, t);
					} catch (_) { /* preview is optional */ }
				});

				/* 2) Reconcile already-injected previews with the fresh block
				   content (e.g. after a GB save) */
				doc.querySelectorAll("[data-eppe-content]").forEach((content) => {
					if (session && session.el === content) return; // currently being edited
					if (activeMirrorEl === content) return; // don't overwrite the live preview
					const block = resolveGbBlockForPreview(content);
					if (!block) return;
					const outer = parseOuter(block.gutenbergBlock.innerHTML);
					if (!outer) return;
					const tmp = content.ownerDocument.createElement("span");
					tmp.innerHTML = outer.innerHTML;
					sanitizeEditorHtml(tmp);
					if (content.innerHTML !== tmp.innerHTML) {
						content.innerHTML = tmp.innerHTML;
					}
				});

				/* 3) Rebuild container previews when they change
				   (signature guard in injectContainerPreview prevents flicker) */
				doc.querySelectorAll("[data-eppe-container]").forEach((el) => {
					if (activeMirrorEl && el.contains(activeMirrorEl)) return; // protect the live line
					const label = el.getAttribute("data-eppe-container");
					const block = resolveContainerBlock(el, label);
					if (!block) return;
					try { injectContainerPreview(el, block, label); } catch (_) { /* optional */ }
				});

				/* Apply the section highlight only after all previews are known,
				   and remove it again when a passthrough disappears. */
				syncGbPreviewHighlights(doc);
			}
			refreshConversionNotice();
		}

		/** Refresh the preview several times, staggered, after a save
		    (Etch re-renders the passthrough placeholder asynchronously) */
		function refreshPreviewBurst() {
			[150, 500, 1000, 1800].forEach((ms) =>
				setTimeout(() => {
					try { runPreviewScan(); } catch (_) { /* optional */ }
				}, ms)
			);
		}

		/* ---------------------------------------------------------------- */
		/* Etch-Textelement im Canvas finden                                 */
		/* ---------------------------------------------------------------- */

		function findCanvasNodeForEtch(block) {
			const html = childrenToHtml(block.children);
			if (html === null) return null;
			const tmp = document.createElement("div");
			tmp.innerHTML = html;
			const expected = normText(tmp.textContent);
			if (!expected) return null;

			const tag = (block.tag || "p").toLowerCase();
			const candidates = [];
			for (const doc of iframeDocs()) {
				if (!doc.body) continue;
				doc.body.querySelectorAll(tag).forEach((el) => {
					if (el.closest(".eppe-tb") || el.closest("[data-eppe-preview]")) return;
					if (normText(el.textContent) === expected) candidates.push(el);
				});
			}

			if (!candidates.length) return null; // block may not be rendered (yet)
			if (candidates.length === 1) return candidates[0];

			/* Mehrere identische Texte: Position im Strukturbaum als Index nutzen */
			let k = 0;
			let found = false;
			const walk = (nodes) =>
				(nodes || []).forEach((n) => {
					if (found) return;
					if (n.type === "etch/element" && (n.tag || "").toLowerCase() === tag) {
						const h = childrenToHtml(n.children);
						if (h !== null) {
							const t = document.createElement("div");
							t.innerHTML = h;
							if (normText(t.textContent) === expected) {
								if (n.id === block.id) {
									found = true;
									return;
								}
								k++;
							}
						}
					}
					walk(n.children);
				});
			try {
				walk(etch.blocks.getTree());
			} catch (_) { /* transitional state */ }

			if (found && candidates[k]) return candidates[k];
			log(`Canvas node ambiguous (${candidates.length} matches for <${tag}>) – popup fallback.`);
			return null;
		}

		/* ---------------------------------------------------------------- */
		/* Workaround Etch bug (1.6.3): double-click inline editor crashes   */
		/* on paragraphs with inline links ("reading 'count'"). We catch    */
		/* the double-click before it reaches Etch's editor and open        */
		/* our own editor instead.                                          */
		/* ---------------------------------------------------------------- */

		function findEtchBlockForNode(node) {
			const tag = node.tagName.toLowerCase();
			const expected = normText(node.textContent);
			if (!expected) return null;
			const matches = [];
			const walk = (nodes) =>
				(nodes || []).forEach((n) => {
					if (n.type === "etch/element" && (n.tag || "").toLowerCase() === tag) {
						const html = childrenToHtml(n.children);
						if (html !== null) {
							const tmp = document.createElement("div");
							tmp.innerHTML = html;
							if (normText(tmp.textContent) === expected) matches.push(n);
						}
					}
					walk(n.children);
				});
			try {
				walk(etch.blocks.getTree());
			} catch (_) { /* transitional state */ }
			return matches.length === 1 ? matches[0] : null;
		}

		function installDblClickGuard(doc) {
			if (doc.__eppeDblGuard) return;
			doc.__eppeDblGuard = true;
			/* Document-level capture runs BEFORE Etch's handlers (which sit
			   deeper in the tree) – so the double-click never reaches the
			   faulty inline editor at all. */
			doc.addEventListener("dblclick", (e) => {
				try {
					if (session) return;
					const t = e.target;
					if (!t || !t.closest) return;
					if (t.closest(".eppe-tb") || t.closest(".eppe-editbtn") || t.closest("[data-eppe-preview]")) return;
					const container = t.closest(ETCH_TEXT_TAGS.join(","));
					if (!container) return;
					if (!container.querySelector("a")) return; // bug only affects inline links
					e.preventDefault();
					e.stopPropagation();
					const block = findEtchBlockForNode(container);
					if (block) {
						log("Bypassed Etch's inline editor (link-bug workaround), opening plugin editor.");
						popup.open({ mode: "etch", block, mirrorEl: container });
					} else {
						toast(doc, "Skipped Etch's inline editor (link bug in Etch 1.6.3). Please use the ✎ Edit button.", true);
					}
				} catch (_) { /* Guard darf nie selbst crashen */ }
			}, true);
		}

		/* ---------------------------------------------------------------- */
		/* Popup                                                             */
		/* ---------------------------------------------------------------- */

		/** Bounding rect of a node in top-window coordinates
		    (accounts for iframe nesting) */
		function nodeRectInTop(node) {
			let r = node.getBoundingClientRect();
			let rect = { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
			let win = node.ownerDocument.defaultView;
			let guard = 0;
			while (win && win !== window.top && guard++ < 10) {
				const fe = win.frameElement;
				if (!fe) break;
				const fr = fe.getBoundingClientRect();
				rect.top += fr.top; rect.bottom += fr.top;
				rect.left += fr.left; rect.right += fr.left;
				win = fe.ownerDocument.defaultView;
			}
			return rect;
		}

		const popup = buildPopup();

		let legacyBrRepairInFlight = false;

		/**
		 * Repair Etch text elements that came back from Gutenberg with a literal
		 * `<br>` string in an `etch/text` node. This runs in the background from
		 * the preview loop, so the HTML panel and the rendered canvas both receive
		 * a real Etch `br` element without requiring a manual popup save.
		 */
		async function repairLegacyEtchBreaks() {
			if (legacyBrRepairInFlight || session || popup.isOpen()) return;

			let candidates = [];
			try {
				const walk = (nodes, insideTextElement) =>
					(nodes || []).forEach((node) => {
						const isTextElement =
							node.type === "etch/element" && ETCH_TEXT_TAGS.includes((node.tag || "").toLowerCase());
						if (isTextElement) {
							if (!insideTextElement && hasLegacyBrText(node.children)) candidates.push(node);
							walk(node.children, true);
							return;
						}
						walk(node.children, insideTextElement);
					});
				walk(etch.blocks.getTree(), false);
			} catch (_) {
				return; // Etch may be between two renders/sync states.
			}
			if (!candidates.length) return;

			legacyBrRepairInFlight = true;
			try {
				const templates = findTemplates(etch);
				let changed = false;
				let selectedReplacementId = null;
				let selectedId = null;
				try { selectedId = etch.blocks.getSelectedId(); } catch (_) { /* optional */ }

				for (const candidate of candidates) {
					let fresh;
					try { fresh = etch.blocks.getJson(candidate.id); } catch (_) { continue; }
					if (!fresh || !hasLegacyBrText(fresh.children)) continue;

					const authoring = toAuthoring(fresh);
					authoring.children = normalizeLegacyBrChildren(authoring.children, templates);
					const newId = etch.blocks.replace(fresh.id, authoring);
					changed = true;
					if (selectedId && containsBlockId(fresh, selectedId)) selectedReplacementId = newId;
				}

				if (!changed) return;
				await etch.saveAsync();
				if (selectedReplacementId) {
					try { etch.blocks.select(selectedReplacementId); } catch (_) { /* optional */ }
				}
				log("Normalized legacy literal <br> line break(s) returned by Gutenberg.");
			} catch (e) {
				err("Legacy line-break repair failed:", apiErrInfo(e));
			} finally {
				legacyBrRepairInFlight = false;
			}
		}

		let nestedGbRepairInFlight = false;

		function isEtchTextElementNode(node) {
			return !!(
				node &&
				node.type === "etch/element" &&
				ETCH_TEXT_TAGS.includes((node.tag || "").toLowerCase())
			);
		}

		function canContainBlockPassthrough(node) {
			if (!node || node.type !== "etch/element") return false;
			const tag = (node.tag || "").toLowerCase();
			return !ETCH_TEXT_TAGS.includes(tag) && !INLINE_TAGS.includes(tag);
		}

		function hasDirectBlockPassthrough(children) {
			return (children || []).some(isBlockGbPassthrough);
		}

		/**
		 * Split a native Etch text element around block-level Gutenberg
		 * passthrough children. The returned sequence can be inserted into the
		 * text element's parent without producing a block inside <p>.
		 */
		function splitTextElementAroundGb(children, textElement) {
			const result = [];
			let textChildren = [];
			const flushTextElement = () => {
				if (!textChildren.length) return;
				result.push({ ...textElement, children: textChildren });
				textChildren = [];
			};

			(children || []).forEach((child) => {
				if (isBlockGbPassthrough(child)) {
					flushTextElement();
					result.push(child);
				} else {
					textChildren.push(child);
				}
			});
			flushTextElement();
			return result;
		}

		/** Recursively promote nested block passthroughs while preserving order. */
		function promoteNestedGbChildren(children) {
			let changed = false;
			const out = [];

			(children || []).forEach((child) => {
				if (isEtchTextElementNode(child) && hasDirectBlockPassthrough(child.children)) {
					out.push(...splitTextElementAroundGb(child.children, child));
					changed = true;
					return;
				}

				const copy = { ...child };
				if (canContainBlockPassthrough(child) && Array.isArray(child.children)) {
					const nested = promoteNestedGbChildren(child.children);
					copy.children = nested.children;
					changed = changed || nested.changed;
				}
				out.push(copy);
			});

			return { children: out, changed };
		}

		/**
		 * Find the native Etch containers that currently contain an invalid
		 * block-level Gutenberg passthrough inside a text element. Only the
		 * outermost affected container is returned; its whole subtree is fixed
		 * in one replace() call so nested replacements cannot overwrite each
		 * other.
		 */
		function collectNestedGbRepairParents(nodes, parent, depth, out, seen) {
			(nodes || []).forEach((node) => {
				if (
					isEtchTextElementNode(node) &&
					hasDirectBlockPassthrough(node.children) &&
					canContainBlockPassthrough(parent) &&
					parent.id &&
					!seen.has(parent.id)
				) {
					seen.add(parent.id);
					out.push({ block: parent, depth });
				}

				if (Array.isArray(node.children)) {
					collectNestedGbRepairParents(node.children, node, depth + 1, out, seen);
				}
			});
		}

		async function promoteNestedGbPassthroughs() {
			if (nestedGbRepairInFlight || session || popup.isOpen()) return;

			let tree;
			try {
				tree = etch.blocks.getTree();
			} catch (_) {
				return;
			}

		const candidates = [];
		collectNestedGbRepairParents(tree, null, 0, candidates, new Set());
		if (!candidates.length) return;

		/* If an affected container contains another affected container, the
		   outer replace() will repair both. */
		candidates.sort((a, b) => a.depth - b.depth);
		const parents = [];
		candidates.forEach((candidate) => {
			if (!parents.some((selected) => containsBlockId(selected.block, candidate.block.id))) {
				parents.push(candidate);
			}
		});

		nestedGbRepairInFlight = true;
		try {
			let changed = false;
			let selectedReplacementId = null;
			let selectedId = null;
			try { selectedId = etch.blocks.getSelectedId(); } catch (_) { /* optional */ }

			for (const candidate of parents) {
				let fresh;
				try { fresh = etch.blocks.getJson(candidate.block.id); } catch (_) { continue; }
				if (!fresh) continue;

				const authoring = toAuthoring(fresh);
				const repaired = promoteNestedGbChildren(authoring.children);
				if (!repaired.changed) continue;
				authoring.children = repaired.children;

				const newId = etch.blocks.replace(fresh.id, authoring);
				changed = true;
				if (selectedId && containsBlockId(fresh, selectedId)) selectedReplacementId = newId;
			}

			if (!changed) return;
			await etch.saveAsync();
			if (selectedReplacementId) {
				try { etch.blocks.select(selectedReplacementId); } catch (_) { /* optional */ }
			}
			log("Promoted nested Gutenberg passthrough block(s) to the Etch container level.");
		} catch (e) {
			err("Nested Gutenberg passthrough repair failed:", apiErrInfo(e));
		} finally {
			nestedGbRepairInFlight = false;
		}
		}

		let backgroundRepairInFlight = false;
		async function runBackgroundRepairs() {
			if (backgroundRepairInFlight || session || popup.isOpen()) return;
			backgroundRepairInFlight = true;
			try {
				await repairLegacyEtchBreaks();
				await promoteNestedGbPassthroughs();
			} finally {
				backgroundRepairInFlight = false;
			}
		}

		/* ---------------------------------------------------------------- */
		/* Optional Gutenberg → native Etch conversion                     */
		/* ---------------------------------------------------------------- */

		let conversionNotice = null;
		let conversionInFlight = false;
		let currentConversionCandidate = null;
		const dismissedConversionKeys = new Set();

		/**
		 * Only standalone core/paragraph passthroughs are offered here.
		 * Paragraphs inside a Gutenberg container remain owned by Gutenberg;
		 * converting the outer container would otherwise destroy its structure.
		 */
		function isConvertibleGbParagraph(node) {
			return !!(
				node &&
				node.type === "etch/passthrough" &&
				node.gutenbergBlock &&
				node.gutenbergBlock.blockName === "core/paragraph" &&
				(!node.gutenbergBlock.innerBlocks || !node.gutenbergBlock.innerBlocks.length) &&
				parseOuter(node.gutenbergBlock.innerHTML)
			);
		}

		function collectConvertibleGbParagraphs() {
			const out = [];
			let tree;
			try { tree = etch.blocks.getTree(); } catch (_) { return out; }

			const walk = (nodes, insidePassthrough) => (nodes || []).forEach((node) => {
				if (node.type === "etch/passthrough") {
					if (!insidePassthrough && isConvertibleGbParagraph(node)) out.push(node);
					/* Nested Gutenberg blocks are part of the wrapper's block JSON,
					   not standalone Etch nodes, so do not descend into them. */
					return;
				}
				walk(node.children, insidePassthrough);
			});
			walk(tree, false);
			return out;
		}

		function conversionKey(block) {
			const gb = block && block.gutenbergBlock;
			return [
				block && block.id,
				gb && gb.blockName,
				gb && gb.innerHTML,
			].join("|");
		}

		function conversionSummary(block) {
			try {
				const outer = parseOuter(block.gutenbergBlock.innerHTML);
				const text = outer ? normText(outer.textContent) : "";
				if (text) return text.length > 90 ? text.slice(0, 87) + "…" : text;
			} catch (_) { /* optional */ }
			return "Empty Gutenberg paragraph";
		}

		function getNativeElementAttributes(element) {
			const attributes = {};
			if (!element) return attributes;
			for (const attr of element.attributes) {
				if (attr.name === "class") {
					const cls = attr.value.split(/\s+/).filter((x) => x && !/^etch-/.test(x));
					if (cls.length) attributes.class = cls.join(" ");
				} else {
					attributes[attr.name] = attr.value;
				}
			}
			return attributes;
		}

		function gbParagraphToEtchElement(block, templates) {
			const outer = parseOuter(block.gutenbergBlock.innerHTML);
			if (!outer) throw new Error("Gutenberg paragraph markup could not be parsed.");
			if (!templates || !templates.elTpl) {
				throw new Error("No native Etch text element template is available.");
			}
			return {
				...baseFrom(templates.elTpl),
				type: "etch/element",
				tag: "p",
				attributes: getNativeElementAttributes(outer),
				children: htmlToChildren(outer, templates),
			};
		}

		function buildConversionNotice() {
			const root = document.createElement("div");
			root.className = "eppe-convert-notice";
			root.hidden = true;
			root.innerHTML = `
				<div class="eppe-convert-title">Gutenberg paragraph found</div>
				<div class="eppe-convert-message">Convert this block to a native Etch text element?</div>
				<div class="eppe-convert-summary"></div>
				<div class="eppe-convert-actions">
					<button type="button" class="eppe-convert-primary">Convert to Etch</button>
					<button type="button" class="eppe-convert-secondary">Keep as Gutenberg</button>
				</div>
			`;
			const notice = {
				root,
				title: root.querySelector(".eppe-convert-title"),
				message: root.querySelector(".eppe-convert-message"),
				summary: root.querySelector(".eppe-convert-summary"),
				primary: root.querySelector(".eppe-convert-primary"),
				secondary: root.querySelector(".eppe-convert-secondary"),
			};
			notice.primary.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void convertCurrentGbParagraph();
			});
			notice.secondary.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				dismissCurrentGbParagraph();
			});
			document.body.appendChild(root);
			return notice;
		}

		function refreshConversionNotice() {
			if (!conversionNotice) return;
			if (session || popup.isOpen() || conversionInFlight || backgroundRepairInFlight) {
				conversionNotice.root.hidden = true;
				return;
			}

			const candidates = collectConvertibleGbParagraphs();
			const candidate = candidates.find((block) => !dismissedConversionKeys.has(conversionKey(block)));
			if (!candidate) {
				currentConversionCandidate = null;
				conversionNotice.root.hidden = true;
				return;
			}

			const key = conversionKey(candidate);
			currentConversionCandidate = { id: candidate.id, key };
			const remaining = candidates.filter((block) => !dismissedConversionKeys.has(conversionKey(block))).length;
			conversionNotice.title.textContent = remaining > 1
				? `${remaining} Gutenberg paragraphs found`
				: "Gutenberg paragraph found";
			conversionNotice.message.textContent = remaining > 1
				? "Convert the next block to a native Etch text element?"
				: "Convert this block to a native Etch text element?";
			conversionNotice.summary.textContent = conversionSummary(candidate);
			conversionNotice.primary.disabled = false;
			conversionNotice.secondary.disabled = false;
			conversionNotice.root.hidden = false;
		}

		function dismissCurrentGbParagraph() {
			if (!currentConversionCandidate) return;
			dismissedConversionKeys.add(currentConversionCandidate.key);
			currentConversionCandidate = null;
			refreshConversionNotice();
		}

		async function convertCurrentGbParagraph() {
			if (conversionInFlight || !currentConversionCandidate) return;
			const requested = currentConversionCandidate;
			conversionInFlight = true;
			conversionNotice.primary.disabled = true;
			conversionNotice.secondary.disabled = true;
			conversionNotice.message.textContent = "Converting this block to Etch…";
			try {
				const fresh = etch.blocks.getJson(requested.id);
				if (!isConvertibleGbParagraph(fresh)) {
					currentConversionCandidate = null;
					return;
				}
				const converted = gbParagraphToEtchElement(fresh, findTemplates(etch));
				const newId = etch.blocks.replace(fresh.id, converted);
				await etch.saveAsync();
				try { etch.blocks.select(newId); } catch (_) { /* optional */ }
				currentConversionCandidate = null;
				log("Converted a standalone Gutenberg paragraph to a native Etch text element.");
				toast(document, "Gutenberg paragraph converted to an Etch text element.", false);
				refreshPreviewBurst();
			} catch (e) {
				err("Gutenberg paragraph conversion failed:", apiErrInfo(e));
				conversionNotice.message.textContent = "Conversion failed — the Gutenberg block was left unchanged.";
				conversionNotice.summary.textContent = apiErrInfo(e);
				conversionNotice.primary.disabled = false;
				conversionNotice.secondary.disabled = false;
			} finally {
				conversionInFlight = false;
				refreshConversionNotice();
			}
		}

		conversionNotice = buildConversionNotice();

		function buildPopup() {
			const panel = document.createElement("div");
			panel.className = "eppe-panel";
			panel.innerHTML = `
				<div class="eppe-head">
					<div><b class="eppe-title">Text</b><span class="eppe-type"></span></div>
					<button class="eppe-close" title="Close">&times;</button>
				</div>
				<div class="eppe-toolbar">
					<button class="eppe-btn" data-cmd="bold" title="Bold — make selected text bold">B</button>
					<button class="eppe-btn eppe-i" data-cmd="italic" title="Italic — slant selected text">I</button>
					<button class="eppe-btn" data-cmd="strikeThrough" title="Strikethrough — cross out selected text" style="text-decoration:line-through;">S</button>
					<button class="eppe-btn" data-cmd="superscript" title="Superscript — raise selected text">x&sup2;</button>
					<button class="eppe-btn" data-cmd="subscript" title="Subscript — lower selected text">x&#8322;</button>
					<div class="eppe-varwrap" style="position:relative;display:inline-flex;">
						<button class="eppe-btn eppe-wtbtn eppe-hasmenu" title="Font weight — choose the weight of selected text" aria-label="Font weight"><span class="eppe-wt-a eppe-wt-thin">A</span><span class="eppe-wt-a eppe-wt-bold">A</span><svg class="eppe-caret" width="8" height="5" viewBox="0 0 8 5" fill="currentColor" aria-hidden="true"><path d="M0 0 L4 5 L8 0 Z"/></svg></button>
						<div class="eppe-wt-results"></div>
					</div>
					<label class="eppe-btn eppe-colorlbl" title="Text color — choose a color for selected text" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">A<input type="color" class="eppe-color" value="#000000" aria-label="Text color" style="width:20px;height:16px;padding:0;border:none;background:none;cursor:pointer;" /></label>
					<div class="eppe-varwrap" style="position:relative;display:inline-flex;">
						<button class="eppe-btn eppe-varbtn eppe-hasmenu" title="Theme color — apply a design-system token (e.g. ACSS)">var<svg class="eppe-caret" width="8" height="5" viewBox="0 0 8 5" fill="currentColor" aria-hidden="true"><path d="M0 0 L4 5 L8 0 Z"/></svg></button>
						<div class="eppe-var-results"></div>
					</div>
					<button class="eppe-btn eppe-linkbtn eppe-icon-btn" title="Link — add or edit a link" aria-label="Add / edit link">${LINK_ICON_SVG}</button>
					<button class="eppe-btn eppe-icon-btn" data-cmd="unlink" title="Remove link — remove the link from selected text" aria-label="Remove link">${UNLINK_ICON_SVG}</button>
					<div class="eppe-varwrap" style="position:relative;display:inline-flex;">
						<button class="eppe-btn eppe-charbtn eppe-hasmenu" title="Insert — line break, soft hyphen or non-breaking space">&para;<svg class="eppe-caret" width="8" height="5" viewBox="0 0 8 5" fill="currentColor" aria-hidden="true"><path d="M0 0 L4 5 L8 0 Z"/></svg></button>
						<div class="eppe-char-results"></div>
					</div>
					<button class="eppe-btn eppe-clear" title="Clear formatting — remove formatting from selected text">T&#8339;</button>
					<button class="eppe-btn eppe-history" data-history="undo" title="Undo — revert the last change (Cmd/Ctrl+Z)" aria-label="Undo" disabled>&#8617;</button>
					<button class="eppe-btn eppe-history" data-history="redo" title="Redo — repeat an undone change (Cmd/Ctrl+Shift+Z)" aria-label="Redo" disabled>&#8618;</button>
				</div>
				<div class="eppe-linkrow" style="position:relative;">
					<div class="eppe-link-primary">
						<input class="eppe-link-url" type="text" placeholder="https://… or search pages, posts &amp; media" autocomplete="off" aria-label="Link URL" />
						<button class="eppe-btn eppe-linkoptions" type="button" aria-expanded="false" aria-controls="eppe-link-options">Options</button>
						<div class="eppe-link-actions">
							<button class="eppe-btn eppe-linkset">Apply</button>
							<button class="eppe-btn eppe-linkcancel" type="button">Cancel</button>
						</div>
					</div>
					<div class="eppe-link-options" id="eppe-link-options" hidden>
						<input class="eppe-link-title" type="text" placeholder="Title (optional)" autocomplete="off" aria-label="Link title" />
						<select class="eppe-link-target" aria-label="Link target">
							<option value="">Default tab</option>
							<option value="_self">Same tab</option>
							<option value="_blank">New tab</option>
							<option value="_parent">Parent frame</option>
							<option value="_top">Top frame</option>
						</select>
						<input class="eppe-link-rel" type="text" placeholder="rel (optional)" autocomplete="off" aria-label="Link relationship" />
					</div>
					<div class="eppe-tb-results"></div>
				</div>
				<div class="eppe-conflict" role="alert" hidden>
					<span class="eppe-conflict-message">This text changed outside the editor.</span>
					<button class="eppe-btn eppe-conflict-reload">Reload latest</button>
					<button class="eppe-btn eppe-conflict-overwrite">Keep mine</button>
				</div>
				<div class="eppe-editor" contenteditable="true" spellcheck="true"></div>
				<div class="eppe-foot">
					<span class="eppe-status">Ready</span>
					<button class="eppe-cancel" title="Discard changes (Esc)">Discard</button>
					<button class="eppe-save eppe-closebtn" title="Save changes and close">Close</button>
				</div>
			`;
			document.body.appendChild(panel);

			/* Replace browser-native title hints with consistent, readable toolbar tooltips. */
			function installToolbarTooltips() {
				const tooltip = document.createElement("div");
				tooltip.className = "eppe-tooltip";
				tooltip.setAttribute("role", "tooltip");
				tooltip.hidden = true;
				document.body.appendChild(tooltip);
				let timer = null;
				let active = null;

				const hide = () => {
					clearTimeout(timer);
					timer = null;
					active = null;
					tooltip.hidden = true;
					tooltip.classList.remove("open");
				};
				const show = (target) => {
					if (active !== target) return;
					tooltip.textContent = target.dataset.eppeTooltip || "";
					tooltip.hidden = false;
					tooltip.classList.add("open");
					const r = target.getBoundingClientRect();
					const tr = tooltip.getBoundingClientRect();
					let top = r.bottom + 8;
					if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 8;
					let left = r.left + (r.width - tr.width) / 2;
					left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
					tooltip.style.left = Math.round(left) + "px";
					tooltip.style.top = Math.round(Math.max(8, top)) + "px";
				};
				const schedule = (target) => {
					if (!target.dataset.eppeTooltip) return;
					hide();
					active = target;
					timer = setTimeout(() => show(target), 360);
				};

				panel.querySelectorAll(".eppe-toolbar [title]").forEach((target) => {
					target.dataset.eppeTooltip = target.getAttribute("title");
					target.removeAttribute("title");
					target.addEventListener("pointerenter", () => schedule(target));
					target.addEventListener("pointerleave", hide);
					target.addEventListener("focus", () => schedule(target));
					target.addEventListener("blur", hide);
				});
			}
			installToolbarTooltips();

			const $ = (sel) => panel.querySelector(sel);
			const editor = $(".eppe-editor");
			const status = $(".eppe-status");
			const linkRow = $(".eppe-linkrow");
			const linkInput = linkRow.querySelector(".eppe-link-url");
			const linkOptionsBtn = linkRow.querySelector(".eppe-linkoptions");
			const linkOptions = linkRow.querySelector(".eppe-link-options");
			const linkTitleInput = linkRow.querySelector(".eppe-link-title");
			const linkTargetSelect = linkRow.querySelector(".eppe-link-target");
			const linkRelInput = linkRow.querySelector(".eppe-link-rel");
			const conflictRow = $(".eppe-conflict");
			const conflictReload = $(".eppe-conflict-reload");
			const conflictOverwrite = $(".eppe-conflict-overwrite");
			const linkCancel = $(".eppe-linkcancel");
			const st = {
				mode: null, blockId: null, passthroughId: null, path: null,
				savedRange: null, originalHtml: "", saving: false,
				mirrorEl: null, mirrorOriginal: null, editingLink: null,
				history: [], historyIndex: -1, historyTimer: null,
				historyRestoring: false, conflict: false,
			};

			/* Live preview: mirror the popup content into the canvas node (visual only) */
			function liveMirror() {
				if (!st.mirrorEl) return;
				try {
					if (!st.mirrorEl.isConnected) return;
					const tmp = document.createElement("div");
					tmp.innerHTML = editor.innerHTML;
					sanitizeEditorHtml(tmp);
					if (st.mirrorEl.innerHTML !== tmp.innerHTML) st.mirrorEl.innerHTML = tmp.innerHTML;
				} catch (_) { /* preview is optional */ }
			}

			const setStatus = (msg, cls) => {
				status.textContent = msg;
				status.className = "eppe-status" + (cls ? " " + cls : "");
			};

			function comparableHtml(html) {
				const probe = document.createElement("div");
				probe.innerHTML = html || "";
				return probe.innerHTML;
			}

			function persistedEditorHtml() {
				try {
					if (st.mode === "gb") {
						const fresh = etch.blocks.getJson(st.blockId);
						const outer = parseOuter(fresh.gutenbergBlock.innerHTML);
						return outer ? outer.innerHTML : "";
					}
					if (st.mode === "gbnested") {
						const fresh = etch.blocks.getJson(st.passthroughId);
						const target = nestedBlockAt(fresh.gutenbergBlock, st.path);
						const outer = target && parseOuter(target.innerHTML);
						return outer ? outer.innerHTML : "";
					}
					if (st.mode === "etch") {
						const fresh = etch.blocks.getJson(st.blockId);
						return childrenToHtml(fresh.children) || "";
					}
				} catch (_) { /* the block may be mid-replacement */ }
				return null;
			}

			function hasExternalChange() {
				const current = persistedEditorHtml();
				return current !== null && comparableHtml(current) !== comparableHtml(st.originalHtml);
			}

			function updateHistoryButtons() {
				const undo = panel.querySelector('[data-history="undo"]');
				const redo = panel.querySelector('[data-history="redo"]');
				if (undo) undo.disabled = st.historyIndex <= 0;
				if (redo) redo.disabled = st.historyIndex < 0 || st.historyIndex >= st.history.length - 1;
			}

			function resetHistory() {
				clearTimeout(st.historyTimer);
				st.historyTimer = null;
				st.history = [editor.innerHTML];
				st.historyIndex = 0;
				updateHistoryButtons();
			}

			function recordHistory(immediate) {
				if (st.historyRestoring || !st.mode || (st.selMark && st.selMark.isConnected)) return;
				if (!immediate) {
					clearTimeout(st.historyTimer);
					st.historyTimer = setTimeout(() => recordHistory(true), 350);
					return;
				}
				st.historyTimer = null;
				const html = editor.innerHTML;
				if (st.history[st.historyIndex] === html) {
					updateHistoryButtons();
					return;
				}
				st.history = st.history.slice(0, st.historyIndex + 1);
				st.history.push(html);
				if (st.history.length > 80) st.history.shift();
				st.historyIndex = st.history.length - 1;
				updateHistoryButtons();
			}

			function applyHistory(index, label) {
				if (index < 0 || index >= st.history.length || index === st.historyIndex) return;
				clearTimeout(st.historyTimer);
				st.historyTimer = null;
				st.historyRestoring = true;
				unmarkSelection(false);
				st.historyIndex = index;
				editor.innerHTML = st.history[index];
				st.historyRestoring = false;
				updateHistoryButtons();
				editor.focus();
				saveRange();
				liveMirror();
				setStatus(label + ".");
			}

			function undo() {
				if (st.historyTimer) recordHistory(true);
				applyHistory(st.historyIndex - 1, "Undid last change");
			}

			function redo() {
				if (st.historyTimer) recordHistory(true);
				applyHistory(st.historyIndex + 1, "Redid change");
			}

			function showConflict() {
				st.conflict = true;
				conflictRow.hidden = false;
				setStatus("Conflict: text changed outside the editor.", "error");
			}

			function hideConflict() {
				st.conflict = false;
				conflictRow.hidden = true;
			}

			function reloadLatest() {
				const latest = persistedEditorHtml();
				if (latest === null) {
					setStatus("Could not reload the latest text.", "error");
					return;
				}
				unmarkSelection(false);
				editor.innerHTML = latest;
				st.originalHtml = editor.innerHTML;
				resetHistory();
				hideConflict();
				liveMirror();
				st.mirrorOriginal = st.mirrorEl ? st.mirrorEl.innerHTML : null;
				editor.focus();
				setStatus("Latest text reloaded.");
			}

			/* Popup nah am zu bearbeitenden Text platzieren (statt unten rechts) */
			function positionPopup(node) {
				panel.style.right = "auto";
				panel.style.bottom = "auto";
				if (!node || !node.isConnected) {
					panel.style.left = Math.max(8, window.innerWidth - 480) + "px";
					panel.style.top = Math.max(8, window.innerHeight - 340) + "px";
					return;
				}
				const r = nodeRectInTop(node);
				const pw = panel.offsetWidth || 460;
				const ph = panel.offsetHeight || 300;
				let top = r.bottom + 12;
				if (top + ph > window.innerHeight - 8) top = r.top - ph - 12;   // otherwise above
				if (top < 8) top = Math.max(8, window.innerHeight - ph - 8);     // otherwise clamp to bottom
				let left = r.left;
				left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
				panel.style.left = left + "px";
				panel.style.top = top + "px";
			}

			function open(target) {
				/* A selection marker can still exist when the selected block changes
				   while the popup is open. Remove it before replacing the editor DOM. */
				unmarkSelection(false);
				st.savedRange = null;
				st.mode = target.mode;
				st.blockId = target.block ? target.block.id : null;
				st.passthroughId = null;
				st.path = null;
				if (target.mode === "gb") {
					const gb = target.block.gutenbergBlock;
					const outer = parseOuter(gb.innerHTML);
					editor.innerHTML = outer ? outer.innerHTML : "";
					$(".eppe-title").textContent = "Gutenberg text";
					$(".eppe-type").textContent =
						(GB_LABELS[gb.blockName] || gb.blockName) +
						(outer ? " <" + outer.tagName.toLowerCase() + ">" : "");
				} else if (target.mode === "gbnested") {
					st.passthroughId = target.passthroughId;
					st.path = target.path;
					const outer = parseOuter(target.innerHTML);
					editor.innerHTML = outer ? outer.innerHTML : "";
					$(".eppe-title").textContent = "Gutenberg text";
					$(".eppe-type").textContent =
						(GB_LABELS[target.blockName] || target.blockName) +
						" in " + (target.containerLabel || "container");
				} else {
					editor.innerHTML = childrenToHtml(target.block.children) || "";
					$(".eppe-title").textContent = "Etch text";
					$(".eppe-type").textContent = "<" + (target.block.tag || "?") + ">";
				}
				setStatus("Ready");
				linkRow.style.display = "none";
				setLinkOptionsOpen(false);
				conflictRow.hidden = true;
				panel.style.display = "flex";
				st.originalHtml = editor.innerHTML;
				st.editingLink = null;
				st.conflict = false;
				resetHistory();
				linkInput.value = "";
				linkTitleInput.value = "";
				linkTargetSelect.value = "";
				linkRelInput.value = "";
				/* Remember the canvas node for live preview */
				st.mirrorEl = target.mirrorEl || null;
				st.mirrorOriginal = st.mirrorEl ? st.mirrorEl.innerHTML : null;
				activeMirrorEl = st.mirrorEl; // protect from preview reconciliation
				positionPopup(st.mirrorEl);   // position near the text
				editor.focus();
			}
			function close(discard) {
				unmarkSelection(false);
				/* On discard, reset the live preview in the canvas */
				if (discard && st.mirrorEl && st.mirrorOriginal != null) {
					try { if (st.mirrorEl.isConnected) st.mirrorEl.innerHTML = st.mirrorOriginal; } catch (_) { /* ignore */ }
				}
				panel.style.display = "none";
				st.mode = null;
				st.blockId = null;
				st.passthroughId = null;
				st.path = null;
				st.originalHtml = "";
				st.editingLink = null;
				st.savedRange = null;
				clearTimeout(st.historyTimer);
				st.historyTimer = null;
				st.history = [];
				st.historyIndex = -1;
				st.conflict = false;
				conflictRow.hidden = true;
				st.mirrorEl = null;
				st.mirrorOriginal = null;
				activeMirrorEl = null;
			}
			/* Update the live preview on every change in the editor */
			new MutationObserver(() => liveMirror()).observe(editor, {
				childList: true, subtree: true, characterData: true, attributes: true,
			});
			/* Closing (X, Close button, click outside) SAVES changes;
			   discarding is the explicit "Discard" button or Esc. */
				$(".eppe-close").addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					saveOrClose();
				});
				$(".eppe-closebtn").addEventListener("click", () => saveOrClose());
				$(".eppe-cancel").addEventListener("click", () => close(true));
				panel.querySelectorAll("[data-history]").forEach((btn) => {
					btn.addEventListener("mousedown", (e) => e.preventDefault());
					btn.addEventListener("click", () => {
						if (btn.dataset.history === "undo") undo();
						else redo();
					});
				});
				conflictReload.addEventListener("mousedown", (e) => e.preventDefault());
				conflictReload.addEventListener("click", reloadLatest);
				conflictOverwrite.addEventListener("mousedown", (e) => e.preventDefault());
				conflictOverwrite.addEventListener("click", () => {
					hideConflict();
					doSave(true);
				});

			/* Auto-save on click outside the popup (top window + canvas) */
			const onOutsideDown = (e) => {
				if (panel.style.display === "none" || panel.style.display === "" || st.saving) return;
				const t = e.target;
				try { if (t && panel.contains(t)) return; } catch (_) { /* cross-doc */ }
				/* the edit button handles its own toggle (open/close) */
				try { if (t && t.closest && t.closest(".eppe-editbtn")) return; } catch (_) { /* ignore */ }
				if (editor.innerHTML !== st.originalHtml) doSave();
				else close();
			};
			document.addEventListener("mousedown", onOutsideDown, true);
			// also listen in all canvas iframes
			setInterval(() => {
				iframeDocs().forEach((d) => {
					if (!d.__eppePopupOutside) {
						d.__eppePopupOutside = true;
						d.addEventListener("mousedown", onOutsideDown, true);
					}
				});
			}, 1000);

			(() => {
				const head = $(".eppe-head");
				let drag = null;
				/* Pointer events + setPointerCapture: dragging stays smooth even
				   when the cursor moves over the canvas iframe */
				head.addEventListener("pointerdown", (e) => {
					if (e.target.closest(".eppe-close")) return;
					const r = panel.getBoundingClientRect();
					drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
					panel.style.right = "auto";
					panel.style.bottom = "auto";
					try { head.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
					e.preventDefault();
				});
				head.addEventListener("pointermove", (e) => {
					if (!drag) return;
					const pw = panel.offsetWidth, ph = panel.offsetHeight;
					const left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - pw));
					const top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - ph));
					panel.style.left = left + "px";
					panel.style.top = top + "px";
				});
				const endDrag = (e) => {
					drag = null;
					try { head.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
				};
				head.addEventListener("pointerup", endDrag);
				head.addEventListener("pointercancel", endDrag);
			})();

			const saveRange = () => {
				const sel = window.getSelection();
				if (sel.rangeCount && editor.contains(sel.anchorNode)) {
					st.savedRange = sel.getRangeAt(0).cloneRange();
				}
			};
			const restoreRange = () => {
				if (!st.savedRange) return false;
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(st.savedRange);
				return true;
			};

			/* While a dropdown is open the editor loses focus and the browser
			   hides the selection. Wrap it in a temporary highlight span so the
			   user still sees what they are about to format. */
			function markSelection() {
				if (st.selMark && st.selMark.isConnected) return;
				if (!st.savedRange || st.savedRange.collapsed) return;
				const span = document.createElement("span");
				span.className = "eppe-selhl";
				const r = st.savedRange.cloneRange();
				try {
					r.surroundContents(span);
				} catch (_) {
					try {
						span.appendChild(r.extractContents());
						r.insertNode(span);
					} catch (__) { return; }
				}
				st.selMark = span;
			}

			function unmarkSelection(restore) {
				const span = st.selMark;
				st.selMark = null;
				if (!span || !span.isConnected) return;
				const parent = span.parentNode;
				const first = span.firstChild;
				const last = span.lastChild;
				while (span.firstChild) parent.insertBefore(span.firstChild, span);
				span.remove();
				if (first && last) {
					try {
						const r = document.createRange();
						r.setStartBefore(first);
						r.setEndAfter(last);
						st.savedRange = r;
						if (restore) {
							const sel = window.getSelection();
							sel.removeAllRanges();
							sel.addRange(r);
						}
					} catch (_) { /* keep previous range */ }
				}
			}

			editor.addEventListener("keyup", saveRange);
			editor.addEventListener("mouseup", saveRange);
			editor.addEventListener("input", () => {
				recordHistory(false);
				if (!st.saving && !st.conflict && editor.innerHTML !== st.originalHtml) {
					setStatus("Unsaved changes.");
				}
			});
			/* Paste always as plain text (strip Word/Pages formatting) */
			editor.addEventListener("paste", (e) => {
				handlePlainPaste(e, document);
				saveRange();
				recordHistory(false);
			});

			panel.querySelectorAll("[data-cmd]").forEach((btn) => {
				btn.addEventListener("mousedown", (e) => e.preventDefault());
				btn.addEventListener("click", () => {
					editor.focus();
					/* Unlink also works with just the caret inside a link */
					if (btn.dataset.cmd === "unlink") {
						saveRange();
						const a = linkAtSelection();
						if (a && (!st.savedRange || st.savedRange.collapsed)) {
							while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a);
								a.remove();
								editor.normalize();
								saveRange();
								recordHistory(true);
								setStatus("Link removed.");
								return;
						}
					}
					document.execCommand(btn.dataset.cmd, false, null);
					saveRange();
					recordHistory(true);
				});
			});

			const applyPopupSpanStyle = (prop, value, label) => {
				if (!restoreRange()) return;
				const sel = window.getSelection();
				if (sel.isCollapsed) { setStatus("Please select the text here in the editing field.", "error"); return; }
				const cssProp = prop === "fontWeight" ? "font-weight"
					: prop === "fontStyle" ? "font-style" : prop;
				const range = sel.getRangeAt(0);
				const span = document.createElement("span");
				span.style[prop] = value;
				try {
					range.surroundContents(span);
				} catch (_) {
					span.appendChild(range.extractContents());
					range.insertNode(span);
				}
				/* 1) Remove the same property from INNER elements */
				span.querySelectorAll("*").forEach((d) => {
					if (d.style && d.style.getPropertyValue(cssProp)) d.style.removeProperty(cssProp);
					if (d.tagName === "SPAN" && !d.getAttribute("style") && !d.className) {
						while (d.firstChild) d.parentNode.insertBefore(d.firstChild, d);
						d.remove();
					}
				});
				/* 2) Remove the same property from ANCESTORS that wrap exactly the
				   same text (this collapses stacked color spans). */
				const selText = normText(span.textContent);
				let anc = span.parentNode;
				while (anc && anc !== editor && anc.nodeType === 1 &&
					INLINE_TAGS.includes(anc.tagName.toLowerCase()) &&
					normText(anc.textContent) === selText) {
					const next = anc.parentNode;
					if (anc.style && anc.style.getPropertyValue(cssProp)) anc.style.removeProperty(cssProp);
					if (anc.tagName === "SPAN" && !anc.getAttribute("style") && !anc.className) {
						while (anc.firstChild) anc.parentNode.insertBefore(anc.firstChild, anc);
						anc.remove();
					}
					anc = next;
				}
				coalesceSpans(editor); // combine font-weight + color into ONE span
				editor.normalize();
				saveRange();
				recordHistory(true);
				setStatus(label + " applied.");
			};

			/* --- Font weight (icon button with a selection list) --- */
			const wtBtn = $(".eppe-wtbtn");
			const wtResults = $(".eppe-wt-results");
			const WEIGHTS = [
				["300", "Light"], ["400", "Regular"], ["500", "Medium"],
				["600", "Semibold"], ["700", "Bold"], ["800", "Extrabold"],
			];
			wtBtn.addEventListener("mousedown", (e) => e.preventDefault());
			wtBtn.addEventListener("click", () => {
				if (wtResults.classList.contains("open")) { wtResults.className = "eppe-wt-results"; unmarkSelection(true); return; }
				saveRange();
				if (!st.savedRange || st.savedRange.collapsed) {
					setStatus("Please select the text here in the editing field.", "error");
					return;
				}
				wtResults.innerHTML = WEIGHTS.map(([v, l]) =>
					`<div class="eppe-var-row" data-wt="${v}">` +
					`<span class="eppe-var-name" style="font-weight:${v}">${l} · ${v}</span></div>`
				).join("");
				wtResults.className = "eppe-wt-results open";
				markSelection();
				wtResults.querySelectorAll(".eppe-var-row").forEach((row) => {
					row.addEventListener("mousedown", (e) => {
						e.preventDefault();
						const v = row.getAttribute("data-wt");
						unmarkSelection(true);
						applyPopupSpanStyle("fontWeight", v, "font-weight " + v);
						wtResults.className = "eppe-wt-results";
					});
				});
			});

			/* --- Insert menu (line break, soft hyphen, non-breaking space) --- */
			const charBtn = $(".eppe-charbtn");
			const charResults = $(".eppe-char-results");
			const CHAR_ITEMS = [
				["br", "&#8629; Line break", "Shift+Enter"],
				["shy", "Soft hyphen", "invisible"],
				["nbsp", "Non-breaking space", "invisible"],
			];
			charBtn.addEventListener("mousedown", (e) => e.preventDefault());
			charBtn.addEventListener("click", () => {
				if (charResults.classList.contains("open")) { charResults.className = "eppe-char-results"; unmarkSelection(true); return; }
				saveRange();
				charResults.innerHTML = CHAR_ITEMS.map(([k, label, hint]) =>
					`<div class="eppe-var-row" data-char="${k}">` +
					`<span class="eppe-var-name">${label}</span>` +
					`<span class="eppe-char-hint">${hint}</span></div>`
				).join("");
				charResults.className = "eppe-char-results open";
				markSelection();
				charResults.querySelectorAll(".eppe-var-row").forEach((row) => {
					row.addEventListener("mousedown", (e) => {
						e.preventDefault();
						unmarkSelection(true);
						const k = row.getAttribute("data-char");
						if (!restoreRange()) editor.focus();
						if (k === "br") document.execCommand("insertHTML", false, "<br>");
						else if (k === "shy") document.execCommand("insertText", false, "\u00AD");
							else document.execCommand("insertText", false, "\u00A0");
							charResults.className = "eppe-char-results";
							saveRange();
							recordHistory(true);
							setStatus(k === "br" ? "Line break inserted." : k === "shy" ? "Soft hyphen inserted." : "Non-breaking space inserted.");
					});
				});
			});

			$(".eppe-color").addEventListener("mousedown", (e) => e.stopPropagation());
			$(".eppe-color").addEventListener("input", (e) => applyPopupSpanStyle("color", e.target.value, "Color"));

			/* --- Theme color variables (tokens) --- */
			const varBtn = $(".eppe-varbtn");
			const varResults = $(".eppe-var-results");
			let tokenNames = null; // loaded on first open

			function ensureTokens() {
				if (tokenNames) return;
				const map = collectAllVars();
				tokenNames = colorTokenNames(map);
				/* Set all variables on the panel so var(--x) is resolvable in the
				   popup (top document) too – for swatches & live preview */
				for (const [n, v] of Object.entries(map)) {
					try { panel.style.setProperty(n, v); } catch (_) { /* ignore */ }
				}
			}

			function resolveColor(name) {
				try {
					const probe = document.createElement("span");
					probe.style.cssText = "position:absolute;opacity:0;pointer-events:none;color:var(" + name + ")";
					panel.appendChild(probe);
					const c = getComputedStyle(probe).color;
					probe.remove();
					return c || "";
				} catch (_) { return ""; }
			}

			function renderTokens(filter) {
				ensureTokens();
				const q = (filter || "").trim().toLowerCase();
				const list = tokenNames.filter((n) => !q || n.toLowerCase().includes(q));
				let html = `<input class="eppe-var-filter" type="text" placeholder="Filter…" value="${escapeAttr(filter || "")}" />`;
				if (!list.length) {
					html += `<div class="eppe-var-empty">No color tokens</div>`;
				} else {
					const rowHtml = (n) =>
						`<div class="eppe-var-row" data-var="${escapeAttr(n)}">` +
						`<span class="eppe-var-sw" style="background:var(${escapeAttr(n)})"></span>` +
						`<span class="eppe-var-name">${escapeHtml(n)}</span></div>`;
					if (q) {
						/* Beim Filtern flache Liste (schneller zu scannen) */
						html += list.slice(0, 200).map(rowHtml).join("");
					} else {
						html += groupColorTokens(list).map((g) =>
							`<div class="eppe-var-group">${escapeHtml(g.family)}</div>` +
							g.rows.map(rowHtml).join("")
						).join("");
					}
				}
				varResults.innerHTML = html;
				varResults.className = "eppe-var-results open";
				const filterInput = varResults.querySelector(".eppe-var-filter");
				filterInput.addEventListener("mousedown", (e) => e.stopPropagation());
				filterInput.addEventListener("input", () => renderTokens(filterInput.value));
				filterInput.addEventListener("keydown", (e) => {
					if (e.key === "Escape") { varResults.className = "eppe-var-results"; }
				});
				varResults.querySelectorAll(".eppe-var-row").forEach((row) => {
					row.addEventListener("mousedown", (e) => {
						e.preventDefault();
						const name = row.getAttribute("data-var");
						unmarkSelection(true);
						applyPopupSpanStyle("color", "var(" + name + ")", "Color " + name);
						varResults.className = "eppe-var-results";
					});
				});
				setTimeout(() => filterInput.focus(), 0);
			}

			varBtn.addEventListener("mousedown", (e) => e.preventDefault());
			varBtn.addEventListener("click", () => {
				if (varResults.classList.contains("open")) { varResults.className = "eppe-var-results"; unmarkSelection(true); return; }
				saveRange(); // save the selection before opening
				if (!st.savedRange || st.savedRange.collapsed) {
					setStatus("Please select the text here in the editing field.", "error");
					return;
				}
				markSelection();
				renderTokens("");
			});

			const linkResults = linkRow.querySelector(".eppe-tb-results");
			let searchTimer = null;
			let activeIdx = -1;

			const renderResults = (items) => {
				activeIdx = -1;
				if (!items) { linkResults.className = "eppe-tb-results"; linkResults.innerHTML = ""; return; }
				if (!items.length) {
					linkResults.innerHTML = `<div class="eppe-tb-result eppe-tb-empty">No matches</div>`;
					linkResults.className = "eppe-tb-results open";
					return;
				}
				linkResults.innerHTML = items.map((it) =>
					`<div class="eppe-tb-result" data-url="${escapeAttr(it.url)}">` +
					`<span class="eppe-tb-rtitle">${escapeHtml(it.title || it.url)}</span>` +
					`<span class="eppe-tb-rtype">${escapeHtml(it.type)}</span></div>`
				).join("");
				linkResults.className = "eppe-tb-results open";
				linkResults.querySelectorAll(".eppe-tb-result").forEach((row) => {
					row.addEventListener("mousedown", (e) => {
						e.preventDefault();
						const u = row.getAttribute("data-url");
						if (u) { linkInput.value = u; applyLink(); }
					});
				});
			};
			const doSearch = (q) => {
				clearTimeout(searchTimer);
				if (/^https?:\/\//i.test(q) || q.startsWith("/") || q.startsWith("#") || q.startsWith("mailto:")) {
					renderResults(null); return;
				}
				if (q.length < 2) { renderResults(null); return; }
				searchTimer = setTimeout(async () => {
					try { renderResults(await searchInternal(q)); }
					catch (e) { log("Internal search failed:", String(e)); renderResults(null); }
				}, 250);
			};

			/* Link at the current selection/caret (for editing an existing link) */
			const linkAtSelection = () => {
				const r = st.savedRange;
				if (!r) return null;
				const findLink = (node) => {
					let n = node && node.nodeType === 3 ? node.parentNode : node;
					while (n && n !== editor) {
						if (n.nodeType === 1 && n.tagName === "A") return n;
						n = n.parentNode;
					}
					return null;
				};
				const start = findLink(r.startContainer);
				const end = findLink(r.endContainer);
				if (start && start === end) return start;
				return findLink(r.commonAncestorContainer);
			};

			const applyLinkAttributes = (a) => {
				if (!a) return;
				const title = linkTitleInput.value.trim();
				const target = linkTargetSelect.value;
				const rel = linkRelInput.value.trim().split(/\s+/).filter(Boolean);
				if (target === "_blank" && !rel.includes("noopener")) rel.push("noopener");
				if (title) a.setAttribute("title", title);
				else a.removeAttribute("title");
				if (target) a.setAttribute("target", target);
				else a.removeAttribute("target");
				if (rel.length) a.setAttribute("rel", [...new Set(rel)].join(" "));
				else a.removeAttribute("rel");
			};

			const setLinkOptionsOpen = (open) => {
				linkOptions.hidden = !open;
				linkOptionsBtn.setAttribute("aria-expanded", open ? "true" : "false");
				linkOptionsBtn.classList.toggle("open", open);
			};

			const closeLinkEditor = (restoreSelection) => {
				linkRow.style.display = "none";
				renderResults(null);
				setLinkOptionsOpen(false);
				st.editingLink = null;
				if (restoreSelection) {
					const hadMarker = st.selMark && st.selMark.isConnected;
					unmarkSelection(true);
					if (!hadMarker) restoreRange();
				}
			};

			linkOptionsBtn.addEventListener("mousedown", (e) => e.preventDefault());
			linkOptionsBtn.addEventListener("click", () => {
				setLinkOptionsOpen(linkOptions.hidden);
			});
			$(".eppe-linkbtn").addEventListener("mousedown", (e) => e.preventDefault());
			$(".eppe-linkbtn").addEventListener("click", () => {
				saveRange();
				const a = linkAtSelection();
				/* Caret inside an existing link → edit it; otherwise a selection is required */
				if ((!st.savedRange || st.savedRange.collapsed) && !a) {
					setStatus("Please select the text here in the editing field (not in the canvas).", "error");
					return;
				}
				st.editingLink = a || null;
				linkRow.style.display = "flex";
				if (!a) markSelection();
				linkInput.value = a ? (a.getAttribute("href") || "") : "";
				linkTitleInput.value = a ? (a.getAttribute("title") || "") : "";
				linkTargetSelect.value = a ? (a.getAttribute("target") || "") : "";
				linkRelInput.value = a ? (a.getAttribute("rel") || "") : "";
				setLinkOptionsOpen(Boolean(a && (linkTitleInput.value || linkTargetSelect.value || linkRelInput.value)));
				renderResults(null);
				linkInput.focus();
				if (linkInput.value) linkInput.select();
				setStatus(a ? "Editing existing link." : "Ready");
			});
			const applyLink = () => {
				const url = linkInput.value.trim();
				if (!url) return;
				/* Editing an existing link: update href and optional attributes */
				if (st.editingLink && st.editingLink.isConnected) {
					st.editingLink.setAttribute("href", url);
					applyLinkAttributes(st.editingLink);
					closeLinkEditor(false);
					recordHistory(true);
					setStatus("Link updated: " + url);
					editor.focus();
					saveRange();
					return;
				}
				unmarkSelection(true);
				if (!restoreRange()) { setStatus("Selection lost – please select the text again.", "error"); return; }
				editor.focus();
				restoreRange();
				document.execCommand("createLink", false, url);
				saveRange();
				applyLinkAttributes(linkAtSelection());
				closeLinkEditor(false);
				recordHistory(true);
				setStatus("Link added: " + url);
			};
			$(".eppe-linkset").addEventListener("click", applyLink);
			linkCancel.addEventListener("mousedown", (e) => e.preventDefault());
			linkCancel.addEventListener("click", () => closeLinkEditor(true));
			linkInput.addEventListener("input", () => doSearch(linkInput.value.trim()));
			linkInput.addEventListener("keydown", (e) => {
				const rows = Array.from(linkResults.querySelectorAll(".eppe-tb-result:not(.eppe-tb-empty)"));
				if (e.key === "ArrowDown" && rows.length) {
					e.preventDefault();
					activeIdx = Math.min(activeIdx + 1, rows.length - 1);
					rows.forEach((r, i) => r.classList.toggle("active", i === activeIdx));
				} else if (e.key === "ArrowUp" && rows.length) {
					e.preventDefault();
					activeIdx = Math.max(activeIdx - 1, 0);
					rows.forEach((r, i) => r.classList.toggle("active", i === activeIdx));
				} else if (e.key === "Enter") {
					e.preventDefault();
					if (activeIdx >= 0 && rows[activeIdx]) linkInput.value = rows[activeIdx].getAttribute("data-url");
					applyLink();
				} else if (e.key === "Escape") {
					if (linkResults.classList.contains("open")) renderResults(null);
					else closeLinkEditor(true);
				}
			});

			/* Keep the dropdown buttons' "open" state (caret + highlight) in sync
			   with their panels, no matter how they were opened or closed */
			[[wtBtn, wtResults], [varBtn, varResults], [charBtn, charResults]].forEach(([b, r]) => {
				new MutationObserver(() => b.classList.toggle("open", r.classList.contains("open")))
					.observe(r, { attributes: true, attributeFilter: ["class"] });
			});

			/* Close open dropdowns (weight, tokens, link results) when clicking
			   anywhere else inside the popup */
			panel.addEventListener("mousedown", (e) => {
				const t = e.target;
				if (!t || !t.closest) return;
				if (wtResults.classList.contains("open") &&
					!t.closest(".eppe-wt-results") && !t.closest(".eppe-wtbtn")) {
					wtResults.className = "eppe-wt-results";
					unmarkSelection(false);
				}
				if (charResults.classList.contains("open") &&
					!t.closest(".eppe-char-results") && !t.closest(".eppe-charbtn")) {
					charResults.className = "eppe-char-results";
					unmarkSelection(false);
				}
				if (varResults.classList.contains("open") &&
					!t.closest(".eppe-var-results") && !t.closest(".eppe-varbtn")) {
					varResults.className = "eppe-var-results";
					unmarkSelection(false);
				}
				if (linkResults.classList.contains("open") &&
					!t.closest(".eppe-tb-results") && !t.closest(".eppe-linkrow")) {
					renderResults(null);
				}
			}, true);

			$(".eppe-clear").addEventListener("mousedown", (e) => e.preventDefault());
			$(".eppe-clear").addEventListener("click", () => {
				editor.focus();
				document.execCommand("removeFormat", false, null);
				document.execCommand("unlink", false, null);
				const sel = window.getSelection();
				const scopeAll = !sel.rangeCount || sel.isCollapsed;
				editor.querySelectorAll("span,strong,em,a,u,s,mark,code,sub,sup").forEach((n) => {
					if (scopeAll || (sel.containsNode && sel.containsNode(n, true))) {
						while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
						n.remove();
					}
				});
				stripEmptyInline(editor);
				editor.normalize();
				saveRange();
				recordHistory(true);
				setStatus("Formatting cleared.");
			});

			async function doSave(force) {
				if (!st.mode || st.saving) return;
				unmarkSelection(false);
				if (!force && editor.innerHTML !== st.originalHtml && hasExternalChange()) {
					showConflict();
					return;
				}
				hideConflict();
				st.saving = true;
				setStatus("Saving…");
				try {
					if (st.mode === "gbnested") {
						const newId = await persistGbNested(st.passthroughId, st.path, editor.innerHTML);
						st.passthroughId = newId;
					} else {
						const newId = st.mode === "gb"
							? await persistGb(st.blockId, editor.innerHTML)
							: await persistEtch(st.blockId, editor.innerHTML);
						st.blockId = newId;
						try { etch.blocks.select(newId); } catch (_) { /* optional */ }
					}
					st.saving = false;
					close(); // close after auto-save
					try { runPreviewScan(); } catch (_) { /* sofortige Aktualisierung */ }
					refreshPreviewBurst(); // + zeitversetzt (Etch rendert asynchron)
				} catch (e) {
					err("Saving failed:", apiErrInfo(e));
					setStatus("Save failed — use Close to retry. " + apiErrInfo(e), "error");
					st.saving = false;
				}
			}

			/* Cmd/Ctrl+Enter speichert, Esc verwirft */
			editor.addEventListener("keydown", (e) => {
				if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
					e.preventDefault();
					if (e.shiftKey) redo();
					else undo();
				} else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "y") {
					e.preventDefault();
					redo();
				} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					if (editor.innerHTML !== st.originalHtml) doSave(); else close(true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					close(true);
				}
			});

			/* Close like a click-outside: save if changed, otherwise just close */
			function saveOrClose() {
				if (panel.style.display === "none" || panel.style.display === "" || st.saving) return;
				if (editor.innerHTML !== st.originalHtml) doSave();
				else close();
			}

			return { open, close, saveOrClose, isOpen: () => panel.style.display !== "none" && panel.style.display !== "" };
		}

		/* ---------------------------------------------------------------- */
		/* Launcher (popup fallback only)                                    */
		/* ---------------------------------------------------------------- */

		const launcher = document.createElement("button");
		launcher.className = "eppe-launcher";
		launcher.innerHTML = "&#9998;&nbsp; Edit text";
		document.body.appendChild(launcher);

		let launcherTarget = null;

		launcher.addEventListener("click", () => {
			if (!launcherTarget) return;
			popup.open(launcherTarget);
			launcher.style.display = "none";
		});

		function resolveTarget(selId) {
			let block = null;
			try {
				block = etch.blocks.getJson(selId);
			} catch (_) {
				return null;
			}
			if (isEditableGb(block)) return { mode: "gb", block };
			const etchEl = resolveEtchTarget(etch, block);
			if (etchEl) return { mode: "etch", block: etchEl };
			return null;
		}

		/* ---------------------------------------------------------------- */
		/* Selection polling                                                 */
		/* ---------------------------------------------------------------- */

		setInterval(() => {
			positionEditBtn(); // am Text „kleben" bleiben (Scroll etc.)
			if (session) return;

			let selId = null;
			try {
				selId = etch.blocks.getSelectedId();
			} catch (_) { /* transitional state */ }

			if (!selId) {
				if (lastSelected !== null) {
					lastSelected = null;
					hideEditBtn();
					launcher.style.display = "none";
				}
				return;
			}

			const selChanged = selId !== lastSelected;
			lastSelected = selId;

			/* Button is already next to the right text → nothing to do.
			   If it's missing (e.g. because the canvas was mid re-render on the
			   last attempt), the search is retried on every tick. */
			if (!selChanged && editBtn) return;

			const target = resolveTarget(selId);
			if (!target) {
				launcherTarget = null;
				hideEditBtn();
				launcher.style.display = "none";
				return;
			}
			launcherTarget = target;

			/* Find the canvas node → edit button right next to the text */
			const node = target.mode === "etch"
				? findCanvasNodeForEtch(target.block)
				: findPreviewNodeForGb(target.block);

			if (node) {
				launcher.style.display = "none";
				showEditBtn(node, target);
			} else {
				hideEditBtn();
				if (popup.isOpen()) {
					if (selChanged) popup.open(target);
				} else {
					launcher.style.display = "flex";
				}
			}
		}, POLL_MS);

		/* ---------------------------------------------------------------- */
		/* Preview loop                                                      */
		/* ---------------------------------------------------------------- */

		setInterval(() => {
			try {
				iframeDocs().forEach(installDblClickGuard); // keep the link-bug workaround active
			} catch (_) { /* optional */ }
			if (session) return;
			try {
				runPreviewScan();
			} catch (_) { /* optional */ }
		}, PREVIEW_MS);
		runPreviewScan();

		window.eppe = { rescan: runPreviewScan, version: VERSION };

		log(`Ready (v${VERSION}). Etch ${etch.version} / API ${etch.apiVersion}.`);
		log("Click a GB preview OR select a text block → \"✎ Edit\" next to the text.");
	}

	/* ================================================================== */
	/* Top-Styles (Launcher + Popup)                                       */
	/* ================================================================== */

	function injectTopStyles() {
		const css = `
		.eppe-launcher {
			position: fixed; right: 20px; bottom: 64px; z-index: 999999;
			display: none; align-items: center; gap: 8px;
			background: #7c3aed; color: #fff; border: none; border-radius: 8px;
			padding: 10px 16px; font: 600 13px/1 var(--e-font-interface, Inter, system-ui, sans-serif);
			cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.35);
		}
		.eppe-launcher:hover { background: #6d28d9; }
		.eppe-launcher,
		.eppe-convert-notice,
		.eppe-convert-notice *,
		.eppe-tooltip,
		.eppe-panel,
		.eppe-panel *,
		.eppe-editbtn {
			font-family: var(--e-font-interface, Inter, system-ui, sans-serif) !important;
		}
		.eppe-editbtn {
			font: 600 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif) !important;
		}
		.eppe-convert-notice {
			position: fixed; top: 20px; right: 20px; z-index: 2147483647;
			width: min(420px, calc(100vw - 40px)); padding: 14px 16px;
			background: #1e1e24; color: #f4f4f6; border: 1px solid #7c3aed;
			border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
			font: 13px/1.45 var(--e-font-interface, Inter, system-ui, sans-serif);
		}
		.eppe-convert-notice[hidden] { display: none !important; }
		.eppe-convert-title { font-size: 14px; font-weight: 700; color: #fff; }
		.eppe-convert-message { margin-top: 3px; color: #d8d8df; }
		.eppe-convert-summary {
			margin-top: 9px; padding: 7px 9px; border-radius: 6px;
			background: #292932; color: #bdbdc8; white-space: nowrap;
			overflow: hidden; text-overflow: ellipsis;
		}
		.eppe-convert-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
		.eppe-convert-actions button {
			border-radius: 6px; padding: 7px 10px; font: 600 12px/1.2 var(--e-font-interface, Inter, system-ui, sans-serif);
			cursor: pointer;
		}
		.eppe-convert-primary { background: #7c3aed; color: #fff; border: 1px solid #7c3aed; }
		.eppe-convert-primary:hover { background: #6d28d9; border-color: #6d28d9; }
		.eppe-convert-secondary { background: transparent; color: #c7c7d0; border: 1px solid #4a4a58; }
		.eppe-convert-secondary:hover { color: #fff; border-color: #747484; }
		.eppe-convert-actions button:disabled { opacity: .5; cursor: default; }
		.eppe-tooltip {
			position: fixed; z-index: 2147483647; max-width: 250px;
			padding: 7px 9px; background: #111116; color: #f4f4f6;
			border: 1px solid #4a4a58; border-radius: 6px;
			box-shadow: 0 5px 18px rgba(0,0,0,.5);
			font: 11px/1.35 var(--e-font-interface, Inter, system-ui, sans-serif); text-align: center;
			pointer-events: none; opacity: 0; transform: translateY(-2px);
			transition: opacity .12s ease, transform .12s ease;
		}
		.eppe-tooltip[hidden] { display: none; }
		.eppe-tooltip.open { opacity: 1; transform: translateY(0); }
		.eppe-panel {
			position: fixed; right: 20px; bottom: 64px; z-index: 1000000;
			width: 640px; max-width: calc(100vw - 40px);
			min-width: 420px; min-height: 260px;
			background: #1e1e24; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
			font: 13px/1.5 var(--e-font-interface, Inter, system-ui, sans-serif); display: none;
			flex-direction: column; resize: both; overflow: hidden;
		}
		.eppe-panel * { box-sizing: border-box; }
		.eppe-head {
			display: flex; align-items: center; justify-content: space-between;
			padding: 10px 14px; border-bottom: 1px solid #3a3a44; cursor: move;
		}
		.eppe-head b { font-size: 13px; }
		.eppe-head .eppe-type { font-size: 11px; color: #a1a1ab; margin-left: 8px; font-weight: 400; }
		.eppe-close {
			background: none; border: none; color: #a1a1ab; font-size: 18px;
			cursor: pointer; line-height: 1; padding: 2px 6px;
		}
		.eppe-close:hover { color: #fff; }
		.eppe-toolbar {
			display: flex; flex-wrap: wrap; gap: 3px; padding: 8px 10px;
			border-bottom: 1px solid #3a3a44; align-items: center;
		}
		.eppe-toolbar .eppe-btn {
			display: inline-flex; align-items: center; justify-content: center;
			height: 30px; min-height: 30px;
		}
		.eppe-btn {
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 5px 10px; cursor: pointer;
			font: 600 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif); min-width: 30px;
		}
		.eppe-btn.eppe-icon-btn {
			display: inline-flex; align-items: center; justify-content: center;
			width: 42px; min-width: 42px; height: 30px; padding: 5px 8px;
		}
		.eppe-btn .eppe-icon {
			display: block; width: 19px; height: 19px; flex: none;
		}
		.eppe-btn:hover { background: #3a3a46; }
		.eppe-history { font-size: 18px; font-weight: 400; line-height: 1; padding: 5px 8px; }
		.eppe-history:disabled, .eppe-history:disabled:hover { opacity: .35; cursor: default; background: #2a2a32; }
		.eppe-btn.eppe-i { font-style: italic; font-weight: 400; }
		.eppe-select {
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 5px 4px; font-size: 12px; cursor: pointer;
			width: auto; max-width: 62px;
		}
		.eppe-btn { white-space: nowrap; }
		.eppe-var-results, .eppe-wt-results, .eppe-char-results {
			display: none; position: absolute; left: 0; top: 100%; margin-top: 4px;
			width: 240px; max-height: 260px; overflow: auto; z-index: 10;
			background: #1e1e24; border: 1px solid #3a3a44; border-radius: 8px;
			box-shadow: 0 8px 28px rgba(0,0,0,.55);
		}
		.eppe-wt-results { width: 150px; }
		.eppe-char-results { width: 230px; left: auto; right: 0; }
		.eppe-var-results.open, .eppe-wt-results.open, .eppe-char-results.open { display: block; }
		.eppe-char-results .eppe-var-row { justify-content: space-between; }
		.eppe-char-hint { font-size: 10px; color: #a1a1ab; text-transform: uppercase; letter-spacing: .4px; }
		/* Buttons that open a dropdown: caret indicator + active state */
		.eppe-hasmenu { display: inline-flex; align-items: center; gap: 4px; }
		.eppe-caret { opacity: .55; flex: none; transition: transform .12s ease; }
		.eppe-hasmenu.open { background: #7c3aed; border-color: #7c3aed; color: #fff; }
		.eppe-hasmenu.open .eppe-caret { opacity: 1; transform: rotate(180deg); }
		.eppe-wtbtn { display: inline-flex; align-items: center; justify-content: center; gap: 1px; line-height: 1; }
		.eppe-wtbtn .eppe-caret { margin-left: 3px; }
		.eppe-wt-a { font-size: 15px; line-height: 1; }
		.eppe-wt-thin { font-weight: 100; }
		.eppe-wt-bold { font-weight: 900; }
		.eppe-var-filter {
			width: 100%; box-sizing: border-box; background: #17171c; color: #f4f4f6;
			border: none; border-bottom: 1px solid #3a3a44; padding: 7px 9px; font-size: 12px; outline: none;
			position: sticky; top: 0;
		}
		.eppe-var-row {
			display: flex; align-items: center; gap: 8px; padding: 5px 9px; cursor: pointer;
			font-size: 12px; color: #e5e5ea;
		}
		.eppe-var-row:hover { background: #7c3aed; color: #fff; }
		.eppe-var-sw {
			width: 14px; height: 14px; border-radius: 3px; flex: none;
			border: 1px solid rgba(255,255,255,.25); background-image:
			linear-gradient(45deg,#555 25%,transparent 25%),linear-gradient(-45deg,#555 25%,transparent 25%),
			linear-gradient(45deg,transparent 75%,#555 75%),linear-gradient(-45deg,transparent 75%,#555 75%);
			background-size: 8px 8px; background-position: 0 0,0 4px,4px -4px,-4px 0;
		}
		.eppe-var-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.eppe-var-empty { padding: 8px 9px; color: #a1a1ab; font-size: 12px; }
		.eppe-var-group {
			position: sticky; top: 32px; background: #17171c; color: #a1a1ab;
			font: 700 10px/1 var(--e-font-interface, Inter, system-ui, sans-serif); letter-spacing: .6px; text-transform: uppercase;
			padding: 6px 9px 4px; border-top: 1px solid #2a2a32;
		}
		.eppe-editor {
			flex: 1 1 auto; min-height: 90px; max-height: 60vh; overflow: auto;
			padding: 12px 14px; outline: none; font-size: 14px; line-height: 1.6;
			background: #17171c; color: #f4f4f6;
		}
		.eppe-panel[style*="height"] .eppe-editor { max-height: none; }
		/* Reset inline elements against global theme/ACSS CSS
		   so that e.g. links don't drop onto their own line as blocks */
		.eppe-editor a, .eppe-editor strong, .eppe-editor em, .eppe-editor span,
		.eppe-editor u, .eppe-editor s, .eppe-editor mark, .eppe-editor code,
		.eppe-editor sub, .eppe-editor sup {
			display: inline !important; margin: 0 !important; padding: 0 !important;
			float: none !important; width: auto !important; max-width: none !important;
			background: transparent !important;
		}
		.eppe-editor a { color: #a78bfa !important; text-decoration: underline !important; }
		.eppe-editor a::before, .eppe-editor a::after { content: none !important; }
		/* Temporary highlight so the selection stays visible while a dropdown
		   is open (the editor loses focus, so the native selection is hidden).
		   Must come after the inline reset above, which forces a transparent bg. */
		.eppe-editor span.eppe-selhl { background: rgba(124,58,237,.55) !important; border-radius: 2px; }
		.eppe-linkrow { display: none; flex-direction: column; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #3a3a44; }
		.eppe-link-primary {
			display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
			gap: 6px; align-items: center;
		}
		.eppe-link-options {
			display: grid; grid-template-columns: minmax(140px, 1.2fr) 110px minmax(120px, 1fr);
			gap: 6px; align-items: center;
		}
		.eppe-link-options[hidden] { display: none; }
		.eppe-linkrow input, .eppe-linkrow select {
			min-width: 0; background: #17171c; color: #f4f4f6; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 6px 8px; font-size: 12px; outline: none;
		}
		.eppe-linkoptions[aria-expanded="true"] { background: #7c3aed; border-color: #7c3aed; color: #fff; }
		.eppe-link-actions { display: flex; gap: 6px; }
		.eppe-link-actions .eppe-btn { flex: 1; }
		.eppe-linkrow select { cursor: pointer; }
		.eppe-conflict {
			display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
			padding: 8px 12px; border-bottom: 1px solid #3a3a44;
			background: #332817; color: #fbbf24;
		}
		.eppe-conflict[hidden] { display: none !important; }
		.eppe-conflict-message { flex: 1 1 220px; font-size: 11px; }
		.eppe-conflict .eppe-btn { padding: 4px 8px; font-size: 11px; }
		.eppe-linkrow .eppe-tb-results {
			display: none; position: absolute; left: 12px; right: 12px; top: 100%; margin-top: 3px;
			background: #1e1e24; border: 1px solid #3a3a44; border-radius: 6px;
			max-height: 200px; overflow: auto; z-index: 5; box-shadow: 0 6px 20px rgba(0,0,0,.5);
		}
		.eppe-linkrow .eppe-tb-results.open { display: block; }
		.eppe-linkrow .eppe-tb-result {
			padding: 6px 9px; cursor: pointer; font-size: 12px; color: #e5e5ea;
			border-bottom: 1px solid #2a2a32; display: flex; justify-content: space-between; gap: 8px;
		}
		.eppe-linkrow .eppe-tb-result:last-child { border-bottom: none; }
		.eppe-linkrow .eppe-tb-result:hover, .eppe-linkrow .eppe-tb-result.active { background: #7c3aed; color: #fff; }
		.eppe-linkrow .eppe-tb-rtype { font-size: 10px; opacity: .6; text-transform: uppercase; }
		.eppe-linkrow .eppe-tb-rtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.eppe-linkrow .eppe-tb-result.eppe-tb-empty { color: #a1a1ab; cursor: default; }
		.eppe-linkrow .eppe-tb-result.eppe-tb-empty:hover { background: #1e1e24; color: #a1a1ab; }
		.eppe-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid #3a3a44; }
		.eppe-status { flex: 1; font-size: 11px; color: #a1a1ab; }
		.eppe-status.ok { color: #34d399; }
		.eppe-status.error { color: #f87171; }
		.eppe-save {
			background: #7c3aed; color: #fff; border: none; border-radius: 6px;
			padding: 8px 16px; font: 600 12px/1 var(--e-font-interface, Inter, system-ui, sans-serif); cursor: pointer;
		}
		.eppe-save:hover { background: #6d28d9; }
		.eppe-save:disabled { opacity: .5; cursor: default; }
		.eppe-cancel {
			background: none; color: #a1a1ab; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 8px 14px; font-size: 12px; cursor: pointer;
		}
		.eppe-cancel:hover { color: #fff; }
		@media (max-width: 720px) {
			.eppe-panel {
				width: calc(100vw - 20px); max-width: calc(100vw - 20px);
				min-width: 0; right: 10px;
			}
			.eppe-link-options { grid-template-columns: 1fr; }
		}
		`;
		const style = document.createElement("style");
		style.id = "eppe-styles";
		style.textContent = css;
		document.head.appendChild(style);
	}

	/* ================================================================== */
	/* Boot                                                                */
	/* ================================================================== */

	(async () => {
		const start = Date.now();
		while (!window.etch) {
			if (Date.now() - start > TIMEOUT_MS) return;
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		try {
			buildUi(window.etch);
		} catch (e) {
			err("Initialization failed:", e);
		}
	})();
})();
