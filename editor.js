/**
 * Etch Text Editor v0.17.0
 * ------------------------------------
 * Inline-Bearbeitung von Text direkt im Etch-Canvas:
 *  - Gutenberg-Passthrough-Blöcke (core/paragraph, core/heading, …):
 *    Vorschau im Canvas anklicken → direkt editieren. Speichern via
 *    replace() → Block bleibt Core-Block, 2-Wege-Sync bleibt erhalten.
 *  - Etch-Textelemente (p, h1–h6, li, …): Auswahl im Builder → schwebender
 *    „✎ Bearbeiten"-Button direkt am Text → inline editieren.
 *  - Schwebende Toolbar: B (strong), I (em), font-weight, Link,
 *    Format entfernen, Speichern (Cmd/Ctrl+Enter), Abbrechen (Esc).
 *  - Popup-Editor als Fallback (wenn der Canvas-Knoten nicht eindeutig
 *    gefunden wird).
 *
 * v0.5.0: Toolbar-Aktionen auf mousedown (robust gegen Etch-Canvas-Handler),
 * Edit-Button erscheint am Text statt unten rechts, Cleanup-Fixes,
 * Schutz gegen doppelt geladene Instanzen.
 */
(() => {
	"use strict";

	const VERSION = "0.17.0";
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
		} catch (_) { /* Builder in Übergangszustand */ }
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

	/**
	 * Verschachtelte, bearbeitbare Textblöcke innerhalb eines Container-Blocks
	 * (core/group, core/columns, core/column, …) sammeln.
	 * Liefert Objekte mit `path` (Index-Kette in innerBlocks), blockName und innerHTML.
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

	/** Passthrough-Container mit mindestens einem verschachtelten Textblock? */
	function isContainerPassthrough(block) {
		if (!block || block.type !== "etch/passthrough" || !block.gutenbergBlock) return false;
		const gb = block.gutenbergBlock;
		if (!gb.innerBlocks || !gb.innerBlocks.length) return false;
		return collectNestedEditable(gb).length > 0;
	}

	/** Innersten Gutenberg-Block über eine Index-Kette (path) holen */
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
				/* Etch-interne Laufzeit-Klassen herausfiltern; styles (Style-IDs)
				   bewusst NICHT als Klassen serialisieren */
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
	 * Vorlagen für neue Knoten: version/context/options von nativ erstellten
	 * Blöcken aus dem Dokument klonen. Minimal-Shapes (version:1, context:{})
	 * akzeptiert die API zwar, aber Etchs Renderer erwartet bei nativen
	 * Blöcken zusätzliche interne Felder → "Error rendering block".
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
		} catch (_) { /* Übergangszustand */ }
		return { textTpl, elTpl };
	}

	function baseFrom(tpl) {
		if (!tpl) return { version: 1, context: {} };
		const base = {
			version: tpl.version ?? 1,
			context: JSON.parse(JSON.stringify(tpl.context || {})),
		};
		delete base.context.name; // Label des Vorlagen-Blocks nicht übernehmen
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
					/* Etch-interne Laufzeit-Klassen (etch-html-block etc.) NIEMALS
					   persistieren – sie erzeugen kaputte Style-Referenzen */
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

	function sanitizeEditorHtml(rootEl) {
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
				/* Etch-interne Laufzeit-Klassen entfernen (etch-html-block etc.) */
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
		walk(rootEl);
		stripEmptyInline(rootEl); // leere Reste (z. B. nach removeFormat) entfernen
		return rootEl.innerHTML;
	}

	/* ================================================================== */
	/* Interne Link-Suche (WordPress REST API)                             */
	/* ================================================================== */

	function restRoot() {
		/* wpApiSettings.root ist im Builder meist vorhanden; sonst Standardpfad */
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

	/** Seiten & Beiträge über die Such-API */
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

	/** Medien/Dateien über den Media-Endpoint */
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

	/** Beide Quellen parallel; einzelne Fehler nicht fatal */
	async function searchInternal(query) {
		const [content, media] = await Promise.all([
			searchContent(query).catch((e) => { log("Content-Suche:", String(e)); return []; }),
			searchMedia(query).catch((e) => { log("Media-Suche:", String(e)); return []; }),
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

	/** Nur echte Farb-Tokens, ohne Etch-/Builder-interne Variablen. */
	function colorTokenNames(vars) {
		const EXCLUDE = /^--(e-|etch|lightningcss|stripe|wp-|admin-)/i;
		const isColor = (v) => /#|rgb|hsl|oklch|oklab|color-mix/i.test(v) || /^var\(/i.test(v);
		return Object.keys(vars)
			.filter((n) => !EXCLUDE.test(n) && isColor(vars[n]))
			.sort();
	}

	/* Bevorzugte Reihenfolge der ACSS-Farbfamilien */
	const TOKEN_FAMILY_ORDER = [
		"primary", "secondary", "tertiary", "accent", "base", "shade", "neutral",
		"action", "success", "danger", "error", "warning", "info",
		"white", "black", "pure-white", "pure-black", "text", "heading", "link",
	];
	/* Abstufungen (heller → dunkler); Grundton (kein Suffix) zuerst */
	const TOKEN_MOD = /-(trans-\d+|ultra-light|semi-light|light|hover|semi-dark|ultra-dark|dark)$/;
	const TOKEN_MOD_RANK = {
		"": 0, "ultra-light": 1, "light": 2, "semi-light": 3, "hover": 4,
		"semi-dark": 5, "dark": 6, "ultra-dark": 7,
	};

	/** Tokens nach Familie gruppieren und sinnvoll ordnen. */
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
		document.querySelectorAll(".eppe-panel, .eppe-launcher, #eppe-styles").forEach((n) => n.remove());

		injectTopStyles();

		/* ---------------------------------------------------------------- */
		/* Persistenz                                                        */
		/* ---------------------------------------------------------------- */

		async function persistGb(blockId, htmlContent) {
			const fresh = etch.blocks.getJson(blockId);
			const gb = fresh.gutenbergBlock;
			const outer = parseOuter(gb.innerHTML);
			if (!outer) throw new Error("innerHTML nicht parsebar");
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

		/** Verschachtelten Textblock in einem Container-Passthrough speichern.
		    Nur der betroffene innere Block wird geändert; die Container-Hülle
		    (innerContent mit den null-Platzhaltern) bleibt unangetastet. */
		async function persistGbNested(passthroughId, path, htmlContent) {
			const fresh = etch.blocks.getJson(passthroughId);
			const gb = JSON.parse(JSON.stringify(fresh.gutenbergBlock)); // tiefe Kopie
			const target = nestedBlockAt(gb, path);
			if (!target) throw new Error("Nested block not found.");

			const outer = parseOuter(target.innerHTML);
			if (!outer) throw new Error("innerHTML nicht parsebar");
			const clone = outer.cloneNode(false);
			clone.innerHTML = htmlContent;
			sanitizeEditorHtml(clone);
			const newOuterHtml = clone.outerHTML;

			/* Whitespace um das Tag herum (z. B. "\n<p>…</p>\n") erhalten */
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
		/* Canvas-Styles (pro iframe-Dokument)                               */
		/* ---------------------------------------------------------------- */

		const CANVAS_CSS = `
		.eppe-tb {
			position: fixed; z-index: 2147483647; display: flex; flex-wrap: wrap;
			gap: 3px; align-items: center; padding: 5px 6px;
			background: #1e1e24; border: 1px solid #3a3a44; border-radius: 8px;
			box-shadow: 0 4px 20px rgba(0,0,0,.45);
			font: 12px/1 system-ui, sans-serif; pointer-events: auto;
		}
		.eppe-tb button {
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 5px; padding: 5px 8px; cursor: pointer;
			font: 600 12px/1 system-ui, sans-serif; min-width: 26px;
			pointer-events: auto;
		}
		.eppe-tb button:hover { background: #3a3a46; }
		.eppe-tb .eppe-tb-i { font-style: italic; font-weight: 400; }
		.eppe-tb .eppe-tb-color {
			display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 5px; padding: 4px 6px; font: 600 12px/1 system-ui, sans-serif;
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
			border-radius: 7px; font: 600 12px/1 system-ui, sans-serif;
			box-shadow: 0 4px 16px rgba(0,0,0,.4);
		}
		.eppe-toast.error { color: #f87171; }
		.eppe-editbtn {
			position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 7px;
			background: #7c3aed; color: #fff; border: none; border-radius: 8px;
			padding: 9px 16px; font: 700 14px/1 system-ui, sans-serif; cursor: pointer;
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

		/** Aktion auf mousedown ausführen – Klick-Phase wird neutralisiert,
		 *  damit Etchs Canvas-Handler und Fokuswechsel nicht dazwischenfunken. */
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
		let activeMirrorEl = null; // Canvas-Knoten, der gerade live vom Popup gespiegelt wird
		let lastSelected = false; // Sentinel: erzwingt Re-Evaluation im Poll

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
				<button class="eppe-tb-link" title="Add link">&#128279;</button>
				<button data-cmd="unlink" title="Remove link">&#128279;&#10060;</button>
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
			/* bevorzugt UNTER dem Element – über dem Element sitzt Etchs eigenes Auswahl-Label */
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
			s.saving = true; // Doppel-Save verhindern (Klick außen + Auto-Save)
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
		 * Bearbeitung sofort ins Etch-Modell committen (→ HTML-Feld aktualisiert
		 * sich sofort) und die Inline-Bearbeitung nahtlos wieder öffnen.
		 * Für diskrete Aktionen wie Unlink/Clear gedacht (nicht beim Tippen).
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

				endSession(false); // aktuelle (jetzt veraltete) Session beenden

				/* Nach dem Re-Render den neuen Knoten finden und Bearbeitung
				   wieder aufnehmen – mehrere Versuche, da das Canvas asynchron
				   neu rendert. */
				const reopen = (tries) => {
					let node = null;
					try {
						const fresh = etch.blocks.getJson(newId);
						node = mode === "etch"
							? findCanvasNodeForEtch(fresh)
							: findPreviewNodeForGb(fresh);
					} catch (_) { /* noch nicht bereit */ }
					if (node) {
						if (mode === "gb") startGbSessionFromPreview(node);
						else startSession("etch", node, () => newId);
					} else if (tries > 0) {
						setTimeout(() => reopen(tries - 1), 150);
					}
				};
				setTimeout(() => reopen(12), 150);
			} catch (e) {
				err("Live-Commit fehlgeschlagen:", apiErrInfo(e));
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

			stripEmptyInline(el); // unsichtbare leere Inline-Reste vor dem Editieren entfernen

			/* Bereits vor dem Öffnen im Canvas gesetzte Textmarkierung übernehmen */
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

			/* Markierung nach dem Fokussieren wiederherstellen (focus collabiert sie sonst) */
			if (preRange) {
				try {
					const sel = win.getSelection();
					sel.removeAllRanges();
					sel.addRange(preRange);
				} catch (_) { /* ignore */ }
			}

			/* Etchs Canvas-Handler vom editierten Element fernhalten */
			const stop = (e) => e.stopPropagation();
			["mousedown", "mouseup", "click", "dblclick", "keydown", "keypress", "keyup", "input", "paste"].forEach((t) => {
				el.addEventListener(t, stop, true);
				cleanup.push(() => el.removeEventListener(t, stop, true));
			});

			/* Toolbar-Events nicht zu Etch durchsickern lassen (Bubble-Phase) */
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

			/* Klick außerhalb des bearbeiteten Absatzes: Session automatisch
			   speichern (bei Änderungen) und ggf. direkt in den angeklickten
			   Textabsatz wechseln – wie in einem normalen Editor. */
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
				} catch (_) { /* nie Etch stören */ }
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
						/* execCommand("unlink") wirkt nur bei echter Markierung –
						   direkte DOM-Manipulation ist sofort sichtbar */
						unwrapInScope("a");
						onSelChange();
						commitLive(); // sofort ins Etch-Modell/HTML-Feld übernehmen
						return;
					}
					doc.execCommand(btn.dataset.cmd, false, null);
					onSelChange();
				});
			});

			/* Markierten Bereich in einen span mit Style-Eigenschaft hüllen
			   (font-weight, color, …) – sofort sichtbar */
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
					renderResults(null); return; // sieht nach echter URL aus → nicht suchen
				}
				if (q.length < 2) { renderResults(null); return; }
				searchTimer = setTimeout(async () => {
					try {
						renderResults(await searchInternal(q));
					} catch (e) {
						log("Interne Suche fehlgeschlagen:", String(e));
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
				commitLive(); // sofort ins Etch-Modell/HTML-Feld übernehmen
			});

			onTap(toolbar.querySelector(".eppe-tb-cancel"), () => endSession(true));

			/* Klick ins Builder-UI (Top-Fenster) während der Bearbeitung:
			   ebenfalls automatisch speichern bzw. schließen */
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
		/* Edit-Button direkt am Text                                        */
		/* ---------------------------------------------------------------- */

		let editBtn = null; // { btn, doc, node, target }

		function hideEditBtn() {
			if (editBtn) {
				try { editBtn.btn.remove(); } catch (_) { /* best-effort */ }
				editBtn = null;
			}
		}

		function positionEditBtn() {
			if (!editBtn) return;
			const { btn, node, doc } = editBtn;
			if (!node.isConnected) { hideEditBtn(); return; }
			const r = node.getBoundingClientRect();
			const h = btn.offsetHeight || 26;
			const w = btn.offsetWidth || 100;
			const win = doc.defaultView;
			let top = r.top - h - 6;
			if (top < 4) top = r.bottom + 6;
			btn.style.top = top + "px";
			btn.style.left = Math.max(4, Math.min(r.right - w, (win.innerWidth || 800) - w - 8)) + "px";
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
					const t = editBtn && editBtn.target;
					const n = editBtn && editBtn.node;
					hideEditBtn();
					if (!t) return;
					/* Einheitlich über das Popup bearbeiten (robuster als Inline).
					   Canvas-Knoten für Live-Vorschau mitgeben: bei Etch das <p>,
					   bei GB das Content-Element der Vorschau. */
					popup.open({ ...t, mirrorEl: n || null });
				});
				doc.body.appendChild(btn);
				editBtn = { btn, doc, node, target };
			}
			editBtn.target = target;
			positionEditBtn();
		}

		/* ---------------------------------------------------------------- */
		/* Canvas-Vorschau für Gutenberg-Blöcke                              */
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
				"display:inline-block;font:700 9px/1.4 system-ui,sans-serif;color:#7c3aed;" +
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
			if (el.parentElement) el.parentElement.style.background = "rgba(124,58,237,.05)";
			el.style.background = "transparent";

			content.addEventListener("mousedown", (e) => e.stopPropagation(), true);
			content.addEventListener("click", (e) => {
				e.stopPropagation();
				e.preventDefault();
				const block = resolveGbBlockForPreview(content);
				if (block && isEditableGb(block)) popup.open({ mode: "gb", block, mirrorEl: content });
			}, true);
		}

		/** Vorschau für Container-Passthroughs (core/group, core/columns, …):
		    zeigt jeden verschachtelten Textblock als eigene, klickbare Zeile.
		    Bearbeitung läuft über das Popup (mode "gbnested"). */
		function injectContainerPreview(el, block, label) {
			const nested = collectNestedEditable(block.gutenbergBlock);
			if (!nested.length) return;

			/* Signatur zum Vermeiden unnötiger Neuaufbauten (Flackern) */
			const sig = nested.map((n) => n.path.join(".") + ":" + n.innerHTML).join("||");
			if (el.getAttribute("data-eppe-sig") === sig && el.getAttribute("data-eppe-preview") === "1") return;

			const doc = el.ownerDocument;
			ensureCanvasStyles(doc);

			el.innerHTML = "";
			const badge = doc.createElement("span");
			badge.textContent = "GB " + label.replace(/^core\//, "");
			badge.style.cssText =
				"display:inline-block;font:700 9px/1.4 system-ui,sans-serif;color:#7c3aed;" +
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
			if (el.parentElement) el.parentElement.style.background = "rgba(124,58,237,.05)";
			el.style.background = "transparent";
		}

		/** Container-Passthrough anhand Label + Positionsindex auflösen
		    (robust gegen id-Wechsel nach dem Speichern) */
		function resolveContainerBlock(previewEl, label) {
			const doc = previewEl.ownerDocument;
			const peers = Array.from(doc.querySelectorAll(`[data-eppe-container="${label}"]`));
			const idx = Math.max(0, peers.indexOf(previewEl));
			const blocks = collectPassthroughs(etch).filter(
				(b) => (b.gutenbergBlock.blockName || "").toLowerCase() === label && isContainerPassthrough(b)
			);
			return blocks[idx] || blocks[0] || null;
		}

		/** Popup für einen verschachtelten Textblock öffnen */
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
			const blocks = collectPassthroughs(etch);
			if (!blocks.length) return;

			const byLabel = {};
			blocks.forEach((b) => {
				const key = (b.gutenbergBlock.blockName || "").toLowerCase();
				(byLabel[key] ||= []).push(b);
			});

			for (const doc of iframeDocs()) {
				if (!doc.body) continue;

				/* 1) Neue Platzhalter mit Vorschau versehen */
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
					} catch (_) { /* Vorschau optional */ }
				});

				/* 2) Bereits injizierte Vorschauen mit dem frischen Blockinhalt
				   abgleichen (z. B. nach einem GB-Speichervorgang) */
				doc.querySelectorAll("[data-eppe-content]").forEach((content) => {
					if (session && session.el === content) return; // wird gerade editiert
					if (activeMirrorEl === content) return; // Live-Vorschau nicht überschreiben
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

				/* 3) Container-Vorschauen bei Änderung neu aufbauen
				   (Signatur-Guard in injectContainerPreview verhindert Flackern) */
				doc.querySelectorAll("[data-eppe-container]").forEach((el) => {
					if (activeMirrorEl && el.contains(activeMirrorEl)) return; // Live-Zeile schützen
					const label = el.getAttribute("data-eppe-container");
					const block = resolveContainerBlock(el, label);
					if (!block) return;
					try { injectContainerPreview(el, block, label); } catch (_) { /* optional */ }
				});
			}
		}

		/** Vorschau nach einem Speichervorgang zeitversetzt mehrfach auffrischen
		    (Etch rendert den Passthrough-Platzhalter asynchron neu) */
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

			if (!candidates.length) return null; // Block evtl. (noch) nicht gerendert
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
			} catch (_) { /* Übergangszustand */ }

			if (found && candidates[k]) return candidates[k];
			log(`Canvas node ambiguous (${candidates.length} matches for <${tag}>) – popup fallback.`);
			return null;
		}

		/* ---------------------------------------------------------------- */
		/* Workaround Etch-Bug (1.6.3): Doppelklick-Inline-Editor crasht     */
		/* bei Absätzen mit Inline-Links ("reading 'count'"). Wir fangen     */
		/* den Doppelklick ab, bevor er Etchs Editor erreicht, und öffnen    */
		/* stattdessen unsere eigene Bearbeitung.                            */
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
			} catch (_) { /* Übergangszustand */ }
			return matches.length === 1 ? matches[0] : null;
		}

		function installDblClickGuard(doc) {
			if (doc.__eppeDblGuard) return;
			doc.__eppeDblGuard = true;
			/* Capture auf Dokument-Ebene läuft VOR Etchs Handlern (die tiefer
			   im Baum hängen) – so erreicht der Doppelklick den fehlerhaften
			   Inline-Editor gar nicht erst. */
			doc.addEventListener("dblclick", (e) => {
				try {
					if (session) return;
					const t = e.target;
					if (!t || !t.closest) return;
					if (t.closest(".eppe-tb") || t.closest(".eppe-editbtn") || t.closest("[data-eppe-preview]")) return;
					const container = t.closest(ETCH_TEXT_TAGS.join(","));
					if (!container) return;
					if (!container.querySelector("a")) return; // Bug betrifft nur Inline-Links
					e.preventDefault();
					e.stopPropagation();
					const block = findEtchBlockForNode(container);
					if (block) {
						log("Bypassed Etch's inline editor (link-bug workaround), opening plugin editor.");
						startSession("etch", container, () => block.id);
					} else {
						toast(doc, "Skipped Etch's inline editor (link bug in Etch 1.6.3). Please use the ✎ Edit button.", true);
					}
				} catch (_) { /* Guard darf nie selbst crashen */ }
			}, true);
		}

		/* ---------------------------------------------------------------- */
		/* Popup                                                             */
		/* ---------------------------------------------------------------- */

		/** BoundingRect eines Knotens in Koordinaten des Top-Fensters
		    (rechnet iframe-Verschachtelung ein) */
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

		function buildPopup() {
			const panel = document.createElement("div");
			panel.className = "eppe-panel";
			panel.innerHTML = `
				<div class="eppe-head">
					<div><b class="eppe-title">Text</b><span class="eppe-type"></span></div>
					<button class="eppe-close" title="Close">&times;</button>
				</div>
				<div class="eppe-toolbar">
					<button class="eppe-btn" data-cmd="bold" title="Bold (strong)">B</button>
					<button class="eppe-btn eppe-i" data-cmd="italic" title="Italic (em)">I</button>
					<button class="eppe-btn" data-cmd="superscript" title="Superscript">x&sup2;</button>
					<button class="eppe-btn" data-cmd="subscript" title="Subscript">x&#8322;</button>
					<select class="eppe-select eppe-weight" title="font-weight">
						<option value="">Wt</option>
						<option value="300">300</option>
						<option value="400">400</option>
						<option value="500">500</option>
						<option value="600">600</option>
						<option value="700">700</option>
						<option value="800">800</option>
					</select>
					<label class="eppe-btn eppe-colorlbl" title="Text color" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">A<input type="color" class="eppe-color" value="#000000" style="width:20px;height:16px;padding:0;border:none;background:none;cursor:pointer;" /></label>
					<div class="eppe-varwrap" style="position:relative;display:inline-flex;">
						<button class="eppe-btn eppe-varbtn" title="Theme color variable">var</button>
						<div class="eppe-var-results"></div>
					</div>
					<button class="eppe-btn eppe-linkbtn" title="Add link">&#128279;</button>
					<button class="eppe-btn" data-cmd="unlink" title="Remove link">&#128279;&#10060;</button>
					<button class="eppe-btn eppe-clear" title="Clear formatting">T&#8339;</button>
				</div>
				<div class="eppe-linkrow" style="position:relative;">
					<input type="text" placeholder="https://… or search pages, posts &amp; media" autocomplete="off" />
					<button class="eppe-btn eppe-linkset">Apply</button>
					<div class="eppe-tb-results"></div>
				</div>
				<div class="eppe-editor" contenteditable="true" spellcheck="true"></div>
				<div class="eppe-foot">
					<span class="eppe-status">Ready</span>
					<button class="eppe-cancel" title="Discard (Esc) – clicking outside saves">Close</button>
				</div>
			`;
			document.body.appendChild(panel);

			const $ = (sel) => panel.querySelector(sel);
			const editor = $(".eppe-editor");
			const status = $(".eppe-status");
			const linkRow = $(".eppe-linkrow");
			const linkInput = linkRow.querySelector("input");
			const st = { mode: null, blockId: null, passthroughId: null, path: null, savedRange: null, originalHtml: "", saving: false, mirrorEl: null, mirrorOriginal: null };

			/* Live-Vorschau: Popup-Inhalt in den Canvas-Knoten spiegeln (nur visuell) */
			function liveMirror() {
				if (!st.mirrorEl) return;
				try {
					if (!st.mirrorEl.isConnected) return;
					const tmp = document.createElement("div");
					tmp.innerHTML = editor.innerHTML;
					sanitizeEditorHtml(tmp);
					if (st.mirrorEl.innerHTML !== tmp.innerHTML) st.mirrorEl.innerHTML = tmp.innerHTML;
				} catch (_) { /* Vorschau optional */ }
			}

			const setStatus = (msg, cls) => {
				status.textContent = msg;
				status.className = "eppe-status" + (cls ? " " + cls : "");
			};

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
				if (top + ph > window.innerHeight - 8) top = r.top - ph - 12;   // sonst darüber
				if (top < 8) top = Math.max(8, window.innerHeight - ph - 8);     // sonst unten klemmen
				let left = r.left;
				left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
				panel.style.left = left + "px";
				panel.style.top = top + "px";
			}

			function open(target) {
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
				panel.style.display = "block";
				st.originalHtml = editor.innerHTML;
				/* Canvas-Knoten für Live-Vorschau merken */
				st.mirrorEl = target.mirrorEl || null;
				st.mirrorOriginal = st.mirrorEl ? st.mirrorEl.innerHTML : null;
				activeMirrorEl = st.mirrorEl; // vor Vorschau-Abgleich schützen
				positionPopup(st.mirrorEl);   // nah am Text platzieren
				editor.focus();
			}
			function close(discard) {
				/* Beim Verwerfen die Live-Vorschau im Canvas zurücksetzen */
				if (discard && st.mirrorEl && st.mirrorOriginal != null) {
					try { if (st.mirrorEl.isConnected) st.mirrorEl.innerHTML = st.mirrorOriginal; } catch (_) { /* ignore */ }
				}
				panel.style.display = "none";
				st.mode = null;
				st.blockId = null;
				st.passthroughId = null;
				st.path = null;
				st.originalHtml = "";
				st.mirrorEl = null;
				st.mirrorOriginal = null;
				activeMirrorEl = null;
			}
			/* Live-Vorschau bei jeder Änderung im Editor aktualisieren */
			new MutationObserver(() => liveMirror()).observe(editor, {
				childList: true, subtree: true, characterData: true, attributes: true,
			});
			/* Schließen (verwerfen) robust: schon auf mousedown reagieren */
			$(".eppe-close").addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				close(true);
			});
			$(".eppe-cancel").addEventListener("click", () => close(true));

			/* Auto-Speichern beim Klick außerhalb des Popups (Top-Fenster + Canvas) */
			const onOutsideDown = (e) => {
				if (panel.style.display !== "block" || st.saving) return;
				const t = e.target;
				try { if (t && panel.contains(t)) return; } catch (_) { /* cross-doc */ }
				if (editor.innerHTML !== st.originalHtml) doSave();
				else close();
			};
			document.addEventListener("mousedown", onOutsideDown, true);
			// zusätzlich in allen Canvas-iframes lauschen
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
				/* Pointer-Events + setPointerCapture: Drag bleibt flüssig, auch
				   wenn der Cursor über das Canvas-iframe fährt */
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
			editor.addEventListener("keyup", saveRange);
			editor.addEventListener("mouseup", saveRange);

			panel.querySelectorAll("[data-cmd]").forEach((btn) => {
				btn.addEventListener("mousedown", (e) => e.preventDefault());
				btn.addEventListener("click", () => {
					editor.focus();
					document.execCommand(btn.dataset.cmd, false, null);
					saveRange();
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
				/* 1) Gleiche Eigenschaft aus INNEREN Elementen entfernen */
				span.querySelectorAll("*").forEach((d) => {
					if (d.style && d.style.getPropertyValue(cssProp)) d.style.removeProperty(cssProp);
					if (d.tagName === "SPAN" && !d.getAttribute("style") && !d.className) {
						while (d.firstChild) d.parentNode.insertBefore(d.firstChild, d);
						d.remove();
					}
				});
				/* 2) Gleiche Eigenschaft aus VORFAHREN entfernen, die exakt denselben
				   Text umschließen (so lösen sich gestapelte Farb-Spans auf). */
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
				editor.normalize();
				saveRange();
				setStatus(label + " applied.");
			};

			$(".eppe-weight").addEventListener("change", (e) => {
				const weight = e.target.value;
				e.target.value = "";
				if (weight) applyPopupSpanStyle("fontWeight", weight, "font-weight " + weight);
			});

			$(".eppe-color").addEventListener("mousedown", (e) => e.stopPropagation());
			$(".eppe-color").addEventListener("input", (e) => applyPopupSpanStyle("color", e.target.value, "Color"));

			/* --- Theme-Farbvariablen (Tokens) --- */
			const varBtn = $(".eppe-varbtn");
			const varResults = $(".eppe-var-results");
			let tokenNames = null; // erst beim ersten Öffnen geladen

			function ensureTokens() {
				if (tokenNames) return;
				const map = collectAllVars();
				tokenNames = colorTokenNames(map);
				/* Alle Variablen auf das Panel setzen, damit var(--x) auch im
				   Popup (Top-Dokument) auflösbar ist – für Swatch & Live-Vorschau */
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
						applyPopupSpanStyle("color", "var(" + name + ")", "Color " + name);
						varResults.className = "eppe-var-results";
					});
				});
				setTimeout(() => filterInput.focus(), 0);
			}

			varBtn.addEventListener("mousedown", (e) => e.preventDefault());
			varBtn.addEventListener("click", () => {
				if (varResults.classList.contains("open")) { varResults.className = "eppe-var-results"; return; }
				saveRange(); // Auswahl vor dem Öffnen sichern
				if (!st.savedRange || st.savedRange.collapsed) {
					setStatus("Please select the text here in the editing field.", "error");
					return;
				}
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
					catch (e) { log("Interne Suche fehlgeschlagen:", String(e)); renderResults(null); }
				}, 250);
			};

			$(".eppe-linkbtn").addEventListener("mousedown", (e) => e.preventDefault());
			$(".eppe-linkbtn").addEventListener("click", () => {
				saveRange();
				if (!st.savedRange || st.savedRange.collapsed) {
					setStatus("Please select the text here in the editing field (not in the canvas).", "error");
					return;
				}
				linkRow.style.display = "flex";
				linkInput.value = "";
				renderResults(null);
				linkInput.focus();
			});
			const applyLink = () => {
				const url = linkInput.value.trim();
				if (!url) return;
				if (!restoreRange()) { setStatus("Selection lost – please select the text again.", "error"); return; }
				editor.focus();
				restoreRange();
				document.execCommand("createLink", false, url);
				linkRow.style.display = "none";
				renderResults(null);
				setStatus("Link added: " + url);
				saveRange();
			};
			$(".eppe-linkset").addEventListener("click", applyLink);
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
					else linkRow.style.display = "none";
				}
			});

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
				setStatus("Formatting cleared.");
			});

			async function doSave() {
				if (!st.mode || st.saving) return;
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
					close(); // nach Auto-Speichern schließen
					try { runPreviewScan(); } catch (_) { /* sofortige Aktualisierung */ }
					refreshPreviewBurst(); // + zeitversetzt (Etch rendert asynchron)
				} catch (e) {
					err("Saving failed:", apiErrInfo(e));
					setStatus("Error: " + apiErrInfo(e), "error");
					st.saving = false;
				}
			}

			/* Cmd/Ctrl+Enter speichert, Esc verwirft */
			editor.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					if (editor.innerHTML !== st.originalHtml) doSave(); else close(true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					close(true);
				}
			});

			return { open, close, isOpen: () => panel.style.display === "block" };
		}

		/* ---------------------------------------------------------------- */
		/* Launcher (nur noch Popup-Fallback)                                */
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
		/* Auswahl-Polling                                                   */
		/* ---------------------------------------------------------------- */

		setInterval(() => {
			positionEditBtn(); // am Text „kleben" bleiben (Scroll etc.)
			if (session) return;

			let selId = null;
			try {
				selId = etch.blocks.getSelectedId();
			} catch (_) { /* Übergangszustand */ }

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

			/* Button steht bereits am richtigen Text → nichts zu tun.
			   Fehlt er (z. B. weil das Canvas beim letzten Versuch mitten im
			   Re-Render war), wird die Suche bei jedem Tick wiederholt. */
			if (!selChanged && editBtn) return;

			const target = resolveTarget(selId);
			if (!target) {
				launcherTarget = null;
				hideEditBtn();
				launcher.style.display = "none";
				return;
			}
			launcherTarget = target;

			/* Canvas-Knoten suchen → Edit-Button direkt am Text */
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
		/* Vorschau-Loop                                                     */
		/* ---------------------------------------------------------------- */

		setInterval(() => {
			try {
				iframeDocs().forEach(installDblClickGuard); // Link-Bug-Workaround aktiv halten
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
			padding: 10px 16px; font: 600 13px/1 system-ui, sans-serif;
			cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.35);
		}
		.eppe-launcher:hover { background: #6d28d9; }
		.eppe-panel {
			position: fixed; right: 20px; bottom: 64px; z-index: 1000000;
			width: 460px; max-width: calc(100vw - 40px);
			background: #1e1e24; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
			font: 13px/1.5 system-ui, sans-serif; display: none;
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
		.eppe-btn {
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 5px 10px; cursor: pointer;
			font: 600 12px/1 system-ui, sans-serif; min-width: 30px;
		}
		.eppe-btn:hover { background: #3a3a46; }
		.eppe-btn.eppe-i { font-style: italic; font-weight: 400; }
		.eppe-select {
			background: #2a2a32; color: #e5e5ea; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 5px 4px; font-size: 12px; cursor: pointer;
			width: auto; max-width: 62px;
		}
		.eppe-btn { white-space: nowrap; }
		.eppe-var-results {
			display: none; position: absolute; left: 0; top: 100%; margin-top: 4px;
			width: 240px; max-height: 260px; overflow: auto; z-index: 10;
			background: #1e1e24; border: 1px solid #3a3a44; border-radius: 8px;
			box-shadow: 0 8px 28px rgba(0,0,0,.55);
		}
		.eppe-var-results.open { display: block; }
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
			font: 700 10px/1 system-ui, sans-serif; letter-spacing: .6px; text-transform: uppercase;
			padding: 6px 9px 4px; border-top: 1px solid #2a2a32;
		}
		.eppe-editor {
			min-height: 90px; max-height: 40vh; overflow: auto;
			padding: 12px 14px; outline: none; font-size: 14px; line-height: 1.6;
			background: #17171c; color: #f4f4f6;
		}
		/* Inline-Elemente gegen globales Theme-/ACSS-CSS zurücksetzen,
		   damit z. B. Links nicht als Block in eine eigene Zeile rutschen */
		.eppe-editor a, .eppe-editor strong, .eppe-editor em, .eppe-editor span,
		.eppe-editor u, .eppe-editor s, .eppe-editor mark, .eppe-editor code,
		.eppe-editor sub, .eppe-editor sup {
			display: inline !important; margin: 0 !important; padding: 0 !important;
			float: none !important; width: auto !important; max-width: none !important;
			background: transparent !important;
		}
		.eppe-editor a { color: #a78bfa !important; text-decoration: underline !important; }
		.eppe-editor a::before, .eppe-editor a::after { content: none !important; }
		.eppe-linkrow { display: none; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #3a3a44; }
		.eppe-linkrow input {
			flex: 1; background: #17171c; color: #f4f4f6; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 6px 8px; font-size: 12px; outline: none;
		}
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
			padding: 8px 16px; font: 600 12px/1 system-ui, sans-serif; cursor: pointer;
		}
		.eppe-save:hover { background: #6d28d9; }
		.eppe-save:disabled { opacity: .5; cursor: default; }
		.eppe-cancel {
			background: none; color: #a1a1ab; border: 1px solid #3a3a44;
			border-radius: 6px; padding: 8px 14px; font-size: 12px; cursor: pointer;
		}
		.eppe-cancel:hover { color: #fff; }
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
