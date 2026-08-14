/**
 * Client half of @dsh-external/dsh-upstream-fixes, hand-written in the
 * client-modules bundle shape (banner registers via __ModuleLoader__.load).
 *
 * The FIRST registration runs at bundle evaluation, i.e. during the
 * `immediately` prefetch tier, before any plugin factory materializes. It
 * installs a factory for the deep source specifier that dsh-sidechain's
 * client bundle requires, delegating to the public runtime client entry —
 * turning the broken require into a resolved one without touching sidechain.
 *
 * The SECOND registration is this plugin's own factory: a no-op function
 * plugin so the client-side loader has a valid entry to construct.
 *
 * Fix 4 (0814): the fetch bridge at the top installs at bundle evaluation
 * (immediately tier, before any settings panel mounts). The plugin-console
 * panel's update button only runs `pnpm update <name>` — a no-op for
 * link:/file: local dependencies and range-bound for registry deps — so its
 * update request and version reads are redirected to this plugin's own
 * /api/upstream-fixes endpoints, which perform real updates (git pull /
 * pnpm update --latest) without editing plugin-console itself:
 *
 *   POST /api/plugin-console/bundles {action:'update'}
 *     -> POST /api/upstream-fixes/update {name}          (real update)
 *   GET  /api/plugin-console/versions
 *   POST /api/plugin-console/versions/refresh
 *     -> original response, local-git rows merged from
 *        /api/upstream-fixes/versions[/refresh]
 *
 * Fix 5 (0814): the dsh-task-board and dsh-ssh sidebar entries inject plain
 * DOM buttons (data-dsh-taskboard-entry / data-dsh-ssh-entry) as direct
 * siblings with no wrapper and no vertical margin, so the two rows touch and
 * render as one glued block. This bundle injects a small stylesheet that
 * gives both entries breathing room — the plugins' own .entry rules never
 * set margin, so an attribute selector applies without fighting them.
 */
(function injectSidebarEntrySpacing() {
  if (typeof document === 'undefined' || document.head === null) return
  const id = '@dsh-external/dsh-upstream-fixes/sidebar-entry-spacing'
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = '@dsh-external/dsh-upstream-fixes'
  style.dataset.pluginCss = id
  style.textContent = '[data-dsh-taskboard-entry],[data-dsh-ssh-entry]{margin:2px 0}'
  document.head.appendChild(style)
})();
(function installFetchBridge() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  const originalFetch = window.fetch
  /** Namespaces the official proxy exposes (learned from settings.describe). */
  const OFFICIAL_EXPOSED = new Set()
  window.fetch = async function (input, init) {
    let pathname = ''
    try { pathname = new URL(typeof input === 'string' ? input : input.url, window.location.origin).pathname }
    catch { pathname = String(input).split('?')[0] }
    const method = (init?.method ?? 'GET').toUpperCase()
    // 1) update action: redirect to the real-update endpoint.
    if (pathname === '/api/plugin-console/bundles' || pathname === '/api/plugin-console/bundles/') {
      if (method === 'POST') {
        let action = null
        let name = null
        try {
          const parsed = JSON.parse(String(init?.body ?? '{}'))
          action = parsed.action
          name = parsed.name
        } catch { /* fall through to the original endpoint */ }
        if (action === 'update' && typeof name === 'string' && name.length > 0) {
          try {
            const response = await originalFetch('/api/upstream-fixes/update', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            })
            // JSON means the real-update route answered (success or failure
            // alike — failure messages must reach the panel). Anything else
            // (SPA fallback before a web restart, network trouble) falls
            // back to the console's original endpoint.
            const type = response.headers.get('content-type') ?? ''
            if (type.includes('json')) return response
          } catch { /* fall back to the original endpoint */ }
        }
      }
    }
    // 2) settings auto-expose: the official proxy serves only its hardcoded
    //    namespace whitelist (WEB_SETTINGS_NAMESPACES + product namespaces +
    //    model providers). Merge this plugin's full redacted host view into
    //    settings.describe, remember which namespaces the official proxy
    //    itself exposed, and route writes for every other registered
    //    namespace through /api/upstream-fixes/settings/* — so plugin
    //    settings cards (task-board, dsh-ssh, ...) read and write without
    //    editing the official whitelist. Responses keep the RPC envelope
    //    ({ type, rpcId, result }) the client zod-parses and rpcId-verifies.
    if (pathname === '/api/settings.describe') {
      const response = await originalFetch(input, init)
      try {
        const body = await response.clone().json()
        const namespaces = body?.result?.value?.namespaces
        if (!Array.isArray(namespaces)) return response
        for (const row of namespaces) {
          if (typeof row?.ns === 'string') OFFICIAL_EXPOSED.add(row.ns)
        }
        const extra = await originalFetch('/api/upstream-fixes/settings/describe', { headers: { accept: 'application/json' } })
        const extraBody = await extra.json()
        if (extraBody?.ok !== true || !Array.isArray(extraBody.namespaces)) return response
        const seen = new Set(namespaces.map((row) => row.ns))
        const merged = [...namespaces, ...extraBody.namespaces.filter((row) => !seen.has(row.ns))]
        return new Response(JSON.stringify({ ...body, result: { ...body.result, value: { ...body.result.value, namespaces: merged } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      } catch {
        return response
      }
    }
    if (pathname === '/api/settings.mutate' || pathname === '/api/settings.update' || pathname === '/api/settings.replace') {
      if (method === 'POST') {
        let rpcId = null
        let payload = null
        try {
          const parsed = JSON.parse(String(init?.body ?? '{}'))
          rpcId = parsed.rpcId
          payload = parsed.payload
        } catch { /* fall through to the original endpoint */ }
        const ns = typeof payload?.ns === 'string' ? payload.ns : ''
        if (rpcId !== null && ns !== '' && OFFICIAL_EXPOSED.size > 0 && !OFFICIAL_EXPOSED.has(ns)) {
          try {
            const mode = pathname.slice('/api/settings.'.length)
            const res = await originalFetch('/api/upstream-fixes/settings/' + mode, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const body = await res.json()
            if (body?.result) {
              return new Response(JSON.stringify({ type: 'server-response', rpcId, result: body.result }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            }
          } catch { /* fall back to the original endpoint */ }
        }
      }
    }
    // 3) version reads: merge this plugin's local-git rows into the
    //    console's registry rows so link: dependencies show real updates.
    if (pathname === '/api/plugin-console/versions' || pathname === '/api/plugin-console/versions/refresh') {
      const response = await originalFetch(input, init)
      try {
        const body = await response.clone().json()
        const extraPath = method === 'POST' ? '/api/upstream-fixes/versions/refresh' : '/api/upstream-fixes/versions'
        const extra = await originalFetch(extraPath, { method, headers: { accept: 'application/json' } })
        const extraBody = await extra.json()
        const extraRows = Array.isArray(extraBody?.versions) ? extraBody.versions : []
        const rows = Array.isArray(body?.versions) ? body.versions : []
        const merged = rows.map((row) => {
          const hit = extraRows.find((entry) => entry.name === row.name)
          if (hit === undefined || hit.latest === null || hit.latest === undefined) return row
          return { ...row, latest: hit.latest, checked: hit.checked === true }
        })
        return new Response(JSON.stringify({ ok: true, versions: merged }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      } catch {
        return response
      }
    }
    return originalFetch(input, init)
  }
})()

window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-runtime/src/client/sessions/context-provenance.ts",
	factory: (require) => ({
		contextProvenance: require("@deepseek-ai/dsh-client-runtime/client").contextProvenance,
	}),
});
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-upstream-fixes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		/* ---- fix 7: dock the dsh-sidechain floating panel into the
		   dsh-better-sidebar tab system ----------------------------------

		   sidechain renders a fixed right-edge aside (z-index 200) that
		   floats over better-sidebar's right panel (z-index 50). Instead of
		   moving the React-owned node (a re-render would then remove it from
		   a parent it no longer lives under), the aside stays mounted and we
		   only restyle it: while this tab is visible the aside is pinned
		   exactly over the tab content rect and re-synced every frame; when
		   another tab is active it is hidden in place; when the sidebar is
		   closed it is handed back to its floating form. Open/close rides
		   sidechain's own Ctrl/Cmd+Shift+E listener via a synthetic keydown.
		*/
		const SIDECHAIN_PANEL_LABELS = ["侧链", "Sidechain"];

		function findSidechainPanel() {
			const nodes = document.querySelectorAll('aside[role="complementary"]');
			for (const node of nodes) {
				const label = node.getAttribute("aria-label") ?? "";
				if (SIDECHAIN_PANEL_LABELS.includes(label)) return node;
			}
			return null;
		}

		/** Fire sidechain's panel toggle shortcut (synthetic event; the
		    listener only checks the modifier bits and the key). */
		function dispatchPanelToggle() {
			try {
				window.dispatchEvent(new KeyboardEvent("keydown", {
					key: "e", code: "KeyE", keyCode: 69, which: 69,
					ctrlKey: true, shiftKey: true, metaKey: false,
					bubbles: true, cancelable: true,
				}));
			} catch { /* ignore */ }
		}

		/**
		 * Dock sidechain's panel into `container` while `isVisible()`.
		 * @returns a disposer that restores the panel and closes it when the
		 * tab was the one that opened it.
		 */
		function attachSidechainPanel(container, isVisible) {
			const ORIGINAL = {};
			let aside = null;
			let integrated = false;
			let openedByUs = false;
			let suppressOpen = false;
			let prevVisible = false;
			let lastToggleAt = 0;
			let rafId = 0;
			let disposed = false;

			function capture(element) {
				for (const key of ["left", "top", "right", "bottom", "height", "width", "maxWidth", "zIndex", "borderLeft", "boxShadow", "visibility"]) {
					ORIGINAL[key] = element.style.getPropertyValue(key);
				}
			}

			function applyDocked(element, rect) {
				element.style.setProperty("position", "fixed");
				element.style.setProperty("left", rect.left + "px");
				element.style.setProperty("top", rect.top + "px");
				element.style.setProperty("right", "auto");
				element.style.setProperty("bottom", "auto");
				element.style.setProperty("height", rect.height + "px");
				element.style.setProperty("width", rect.width + "px");
				element.style.setProperty("maxWidth", "none");
				element.style.setProperty("zIndex", "51");
				element.style.setProperty("borderLeft", "none");
				element.style.setProperty("boxShadow", "none");
				element.style.setProperty("visibility", "");
			}

			function restore(element) {
				for (const key of Object.keys(ORIGINAL)) {
					element.style.setProperty(key, ORIGINAL[key]);
				}
			}

			const frame = () => {
				if (disposed) return;
				rafId = requestAnimationFrame(frame);
				const visible = isVisible();
				if (visible && !prevVisible) suppressOpen = false;
				prevVisible = visible;
				const rect = container.getBoundingClientRect();
				const onScreen = rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth;
				const current = findSidechainPanel();
				if (current !== aside) {
					if (current === null && aside !== null) {
						// The panel closed (its own X / toggle): respect that.
						if (visible) suppressOpen = true;
						restore(aside);
						integrated = false;
						openedByUs = false;
					}
					aside = current;
					if (aside !== null) {
						capture(aside);
						integrated = false;
					}
				}
				if (aside === null) {
					if (visible && onScreen && !suppressOpen && Date.now() - lastToggleAt > 500) {
						lastToggleAt = Date.now();
						openedByUs = true;
						dispatchPanelToggle();
					}
					return;
				}
				if (visible && onScreen) {
					applyDocked(aside, rect);
					integrated = true;
				} else if (onScreen) {
					// Sidebar open, another tab active: keep the panel mounted
					// but out of sight instead of overlapping the sidebar.
					if (integrated) { restore(aside); integrated = false; }
					aside.style.setProperty("visibility", "hidden");
				} else {
					// Sidebar closed: hand the panel back to its floating form.
					if (integrated) { restore(aside); integrated = false; }
					aside.style.setProperty("visibility", "");
				}
			};

			rafId = requestAnimationFrame(frame);
			return () => {
				disposed = true;
				cancelAnimationFrame(rafId);
				const current = findSidechainPanel();
				if (current !== null) {
					restore(current);
					current.style.setProperty("visibility", "");
				}
				if (openedByUs && current !== null) dispatchPanelToggle();
			};
		}

		/** Thin tab body: the sidechain panel is docked over this rect. */
		function SidechainTab(props) {
			const holder = react.useRef(null);
			const visibleRef = react.useRef(props.visible === true);
			visibleRef.current = props.visible === true;
			react.useEffect(() => {
				if (holder.current === null) return undefined;
				return attachSidechainPanel(holder.current, () => visibleRef.current);
			}, []);
			return react.createElement("div", {
				ref: holder,
				style: { width: "100%", height: "100%", minHeight: 0 },
			});
		}

		exports.name = "upstream-fixes";
		exports.inject = ["betterSidebar"];
		exports.apply = function apply(ctx) {
			const service = ctx.get("betterSidebar");
			if (service === undefined || typeof service.registerTab !== "function") return;
			ctx.effect(() => service.registerTab({
				id: "sidechain",
				title: "Sidechain",
				order: 90,
				single: true,
				component: SidechainTab,
			}), "upstream-fixes: sidechain tab in better-sidebar");
		};
		return module.exports;
	},
});
