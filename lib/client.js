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
  style.textContent = '[data-dsh-taskboard-entry],[data-dsh-ssh-entry]{margin:2px 0}.ufx-sidechain-bringup{visibility:hidden !important}'
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

		/* ---- own side-chat implementation (replaces dsh-sidechain) -----

		   The host half registers /side (durable continuable child) and /chat
		   (pure-chat child) on the official subagent fork backend; this client
		   half renders the rest, written from scratch:

		   1. command cards for both slash commands (keyed
		      `conversation.chat.commandview`) with a "view in sidebar" jump
		      that preselects the child parsed from the command outcome;
		   2. a `sidechat` tab in dsh-better-sidebar (official registry):
		      child list with live state, embedded transcript, reply composer
		      for continuable children, interrupt for running ones;
		   3. a Ctrl/Cmd+Shift+E shortcut and a session-header toggle that
		      both open the tab.
		*/
		const SIDE_TAB_TYPE = "sidechat";
		const SIDE_TAB_PATH = "sidechat";
		/** The docking-era tab id: better-sidebar persists open tabs to
		    localStorage, so a tab from before the rename would otherwise
		    render as a permanent "plugin not loaded" orphan. Registering a
		    hidden alias under the old id lets that persisted tab recover. */
		const LEGACY_SIDE_TAB_TYPE = "sidechain";
		const CHILD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
		const POLL_INTERVAL_MS = 3000;

		/** Cross-surface jump target: a command card can preselect one child.
		    Held with a TTL because the child may not be in the catalog yet on
		    the first poll after the command settles. */
		let requestedChild = null;
		const SELECTION_TTL_MS = 15000;

		function requestSideChatSelection(childId) {
			requestedChild = { id: childId, at: Date.now() };
		}

		/** The pending selection while fresh; cleared when expired. */
		function pendingSelection() {
			if (requestedChild === null) return null;
			if (Date.now() - requestedChild.at > SELECTION_TTL_MS) {
				requestedChild = null;
				return null;
			}
			return requestedChild.id;
		}

		/** Consume the pending selection once the child shows up. */
		function clearRequestedSelection() {
			requestedChild = null;
		}


		/** The connection handle's api surface (settings bridge uses fetch, the
		    panel uses the typed RPC client). */
		function sideChatApi(ctx) {
			const connection = ctx.get?.("connection");
			return connection?.api ?? null;
		}

		/** Small chat-bubble tab icon (own inline SVG, 16px stroke style). */
		function sideChatIcon(size) {
			return react.createElement("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
			},
				react.createElement("rect", { x: 1.5, y: 2.5, width: 13, height: 9, rx: 2 }),
				react.createElement("path", { d: "M4.5 11.5 2.8 14h4.4" }),
				react.createElement("path", { d: "M6 6.5h4M6 8.5h2.5" }),
			);
		}

		const panelStyles = {
			root: { display: "flex", flexDirection: "column", gap: 8, padding: 10, height: "100%", boxSizing: "border-box", fontSize: 13, color: "var(--dsw-alias-label-primary)" },
			header: { display: "flex", alignItems: "center", gap: 8 },
			title: { flex: 1, fontWeight: 600, fontSize: 13, margin: 0 },
			button: { font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", borderRadius: 6, padding: "3px 8px", fontSize: 12 },
			list: { display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", flexShrink: 0 },
			row: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: "transparent", border: "none", color: "inherit", textAlign: "left", width: "100%", font: "inherit" },
			rowSelected: { background: "var(--dsw-specific-sidebar-nav-item-active)" },
			dot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e", flex: "none" },
			dotIdle: { background: "var(--dsw-alias-label-tertiary)" },
			label: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 },
			meta: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", flex: "none" },
			transcript: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 },
			bubble: { padding: "6px 8px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
			bubbleUser: { background: "var(--dsw-alias-bg-module-platform)" },
			bubbleAssistant: { background: "var(--dsw-alias-bg-layer-3)" },
			role: { fontSize: 10, color: "var(--dsw-alias-label-tertiary)", marginBottom: 2 },
			composer: { display: "flex", gap: 6 },
			input: { flex: 1, font: "inherit", fontSize: 12, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, background: "var(--dsw-alias-bg-layer-3)", color: "inherit", padding: "5px 8px", minWidth: 0 },
			empty: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, textAlign: "center", padding: "20px 8px" },
			activity: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", margin: 0 },
		};

		/** Extract the plain text of one user/assistant message event. */
		function eventText(event) {
			if (event?.type !== "user/message" && event?.type !== "assistant/message") return null;
			const content = event?.data?.content;
			if (!Array.isArray(content)) return null;
			const text = content
				.filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n");
			return text.length > 0 ? text : null;
		}

		/** History events -> display rows ({ role, text }), messages only. */
		function transcriptRows(events) {
			const rows = [];
			for (const entry of events ?? []) {
				const text = eventText(entry?.event);
				if (text === null) continue;
				rows.push({ role: entry.event.type === "user/message" ? "user" : "assistant", text });
			}
			return rows;
		}

		/** The Side chat tab body (better-sidebar TabComponentProps in). */
		function SideChatPanel(props) {
			const sessionId = props.scope?.sessionId;
			const visible = props.visible === true;
			const api = sideChatApi(props.ctx);
			const [rows, setRows] = react.useState([]);
			const [selected, setSelected] = react.useState(null);
			const [messages, setMessages] = react.useState([]);
			const [draft, setDraft] = react.useState("");
			const [newDraft, setNewDraft] = react.useState("");
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const selectedRow = rows.find((row) => row.kind === "child" && row.id === selected) ?? null;
			const replyMode = selectedRow !== null && selectedRow.mode === "continuable";

			// 子代理名称 -> 模型 配置区状态。
			const [showModels, setShowModels] = react.useState(false);
			const [modelConfig, setModelConfig] = react.useState({});
			const [modelOptions, setModelOptions] = react.useState([]);
			const [modelName, setModelName] = react.useState("");
			const [modelPick, setModelPick] = react.useState("");
			const [modelBusy, setModelBusy] = react.useState(false);

			const loadTranscript = react.useCallback(async (childId, mode) => {
				const result = await api.subagents.history({
					parentSessionId: sessionId,
					childSessionId: childId,
					mode,
					maxMessages: 80,
				});
				if (!result?.result?.ok) throw new Error(result?.result?.message ?? "transcript unavailable");
				setMessages(transcriptRows(result.result.value?.events));
			}, [api, sessionId]);

			const refresh = react.useCallback(async (options = {}) => {
				if (api === null) return;
				try {
					const result = await api.subagents.list({ parentSessionId: sessionId });
					if (!result?.result?.ok) throw new Error(result?.result?.message ?? "list failed");
					const entries = result.result.value?.entries ?? [];
					setRows(entries);
					const wanted = pendingSelection();
					if (wanted !== null) {
						const entry = entries.find((candidate) => candidate.kind === "child" && candidate.id === wanted);
						if (entry !== undefined) {
							clearRequestedSelection();
							setSelected(wanted);
							try { await loadTranscript(wanted, entry.mode) } catch { /* keep silent */ }
						}
					}
					// Keep the selected running child's transcript fresh.
					const current = selected !== null ? entries.find((candidate) => candidate.kind === "child" && candidate.id === selected) : undefined;
					if (current !== undefined && current.activity === "running") {
						try { await loadTranscript(current.id, current.mode) } catch { /* keep silent */ }
					}
				} catch (caught) {
					if (options.silent !== true) setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					if (options.silent !== true) setBusy(false);
				}
			}, [api, sessionId, selected, loadTranscript]);

			// Reset when the conversation changes.
			react.useEffect(() => {
				setSelected(null);
				setMessages([]);
				setDraft("");
				setNewDraft("");
				setError(null);
			}, [sessionId]);

			// Poll while the tab is the visible one.
			react.useEffect(() => {
				if (!visible || sessionId === undefined || api === null) return undefined;
				void refresh({ silent: true });
				const timer = setInterval(() => { void refresh({ silent: true }) }, POLL_INTERVAL_MS);
				return () => { clearInterval(timer) };
			}, [visible, sessionId, api, refresh]);

			const select = (entry) => {
				setSelected(entry.id);
				setBusy(true);
				loadTranscript(entry.id, entry.mode)
					.then(() => { setBusy(false); })
					.catch((caught) => { setBusy(false); setError(caught instanceof Error ? caught.message : String(caught)) });
			};

			const sendReply = async () => {
				const text = draft.trim();
				if (text === "" || selectedRow === null || selectedRow.mode !== "continuable") return;
				setBusy(true);
				try {
					const result = await api.subagents.prompt({
						parentSessionId: sessionId,
						childSessionId: selected,
						mode: "continuable",
						content: [{ type: "text", text }],
					});
					if (!result?.result?.ok) throw new Error(result?.result?.message ?? "send failed");
					setDraft("");
					await loadTranscript(selected, "continuable");
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy(false);
				}
			};

			const interrupt = async () => {
				if (selectedRow === null || selectedRow.activity !== "running") return;
				try {
					await api.subagents.interrupt({ parentSessionId: sessionId, childSessionId: selected, mode: selectedRow.mode });
					await refresh({ silent: true });
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				}
			};

			const loadModelConfig = async () => {
				try {
					const response = await window.fetch("/api/upstream-fixes/subagent-models", { headers: { accept: "application/json" } });
					const body = await response.json();
					if (body?.ok === true && body.models !== null && typeof body.models === "object") setModelConfig(body.models);
				} catch { /* 配置读取失败不阻塞面板 */ }
			};

			/** 模型列表来自官方 llm.models RPC（provider 分组）。 */
			const loadModelOptions = async () => {
				if (api === null || typeof api.llm?.models !== "function") return;
				try {
					const result = await api.llm.models({});
					const groups = result?.result?.value?.groups;
					if (!Array.isArray(groups)) return;
					const options = [];
					for (const group of groups) {
						for (const model of group.models ?? []) {
							options.push({ value: group.id + "/" + model.id, label: group.name + " / " + model.name });
						}
					}
					setModelOptions(options);
				} catch { /* 模型列表读取失败不阻塞面板 */ }
			};

			const addModel = async () => {
				const name = modelName.trim();
				if (name === "" || modelPick === "") return;
				const slash = modelPick.indexOf("/");
				const provider = modelPick.slice(0, slash);
				const model = modelPick.slice(slash + 1);
				setModelBusy(true);
				try {
					const response = await window.fetch("/api/upstream-fixes/subagent-models", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name, provider, model }),
					});
					const body = await response.json();
					if (body?.ok !== true) throw new Error(body?.message ?? "保存失败");
					setModelConfig(body.models ?? {});
					setModelName("");
					setModelPick("");
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setModelBusy(false);
				}
			};

			const removeModel = async (name) => {
				setModelBusy(true);
				try {
					const response = await window.fetch("/api/upstream-fixes/subagent-models", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name, remove: true }),
					});
					const body = await response.json();
					if (body?.ok !== true) throw new Error(body?.message ?? "删除失败");
					setModelConfig(body.models ?? {});
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setModelBusy(false);
				}
			};

			// 打开「模型」区时拉取配置与官方模型列表（定义在下方函数之后，
			// 避免 TDZ：真实 React 的 effect 在渲染后执行，但保持顺序干净）。
			react.useEffect(() => {
				if (!showModels) return;
				void loadModelConfig();
				void loadModelOptions();
			}, [showModels]);

			/** Start a brand-new pure-chat side conversation from the panel:
			    a direct host route creates the child — NOT the slash-command
			    pipeline — so nothing leaks into the main conversation. */
			const startChat = async () => {
				const text = newDraft.trim();
				if (text === "") return;
				setBusy(true);
				try {
					const response = await window.fetch("/api/upstream-fixes/sidechat/start", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, text }),
					});
					const body = await response.json();
					if (body?.ok !== true) throw new Error(body?.message ?? "start failed");
					const childId = typeof body.childId === "string" ? body.childId : null;
					setNewDraft("");
					if (childId !== null) requestSideChatSelection(childId);
					await refresh({ silent: true });
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy(false);
				}
			};

			return react.createElement("div", { style: panelStyles.root },
				react.createElement("div", { style: panelStyles.header },
					react.createElement("p", { style: panelStyles.title }, "Side chat"),
					react.createElement("button", { type: "button", style: panelStyles.button, onClick: () => { setShowModels((value) => !value) } }, showModels ? "收起模型" : "模型"),
					react.createElement("button", { type: "button", style: panelStyles.button, disabled: busy, onClick: () => { setBusy(true); void refresh() } }, "刷新"),
				),
				showModels ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid var(--dsw-alias-border-l2)", paddingBottom: 8 } },
					react.createElement("p", { style: { ...panelStyles.activity, color: "var(--dsw-alias-label-secondary)" } }, "子代理模型：以「名称 问题」开头派发（如 /chat work 帮我总结），将严格使用这里绑定的模型。"),
					Object.keys(modelConfig).length === 0 ? react.createElement("p", { style: panelStyles.activity }, "暂无绑定。") : null,
					Object.entries(modelConfig).map(([name, entry]) => react.createElement("div", { key: name, style: { display: "flex", alignItems: "center", gap: 6 } },
						react.createElement("span", { style: { fontWeight: 600, fontSize: 12 } }, name),
						react.createElement("span", { style: { ...panelStyles.meta, flex: 1 } }, entry.provider + " / " + entry.model),
						react.createElement("button", { type: "button", style: panelStyles.button, disabled: modelBusy, onClick: () => { void removeModel(name) } }, "删除"),
					)),
					react.createElement("div", { style: panelStyles.composer },
						react.createElement("input", {
							style: panelStyles.input,
							value: modelName,
							placeholder: "子代理名称（如 work）",
							onChange: (event) => { setModelName(event.target.value) },
						}),
						react.createElement("select", {
							style: { ...panelStyles.input, maxWidth: 220 },
							value: modelPick,
							onChange: (event) => { setModelPick(event.target.value) },
						},
							react.createElement("option", { value: "" }, "选择模型…"),
							modelOptions.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label)),
						),
						react.createElement("button", { type: "button", style: panelStyles.button, disabled: modelBusy || modelName.trim() === "" || modelPick === "", onClick: () => { void addModel() } }, "添加"),
					),
				) : null,
				error !== null ? react.createElement("p", { style: { ...panelStyles.empty, color: "var(--dsw-alias-state-error-primary)", padding: "4px 8px" } }, error) : null,
				rows.length === 0 ? react.createElement("p", { style: panelStyles.empty }, "暂无侧边会话——在输入框直接对话，或用 /side、/chat 启动。") : null,
				react.createElement("div", { style: panelStyles.list },
					rows.map((row) => {
						if (row.kind !== "child") return null;
						const isSelected = row.id === selected;
						return react.createElement("button", {
							key: row.id,
							type: "button",
							style: { ...panelStyles.row, ...(isSelected ? panelStyles.rowSelected : {}) },
							onClick: () => { select(row) },
						},
							react.createElement("span", { style: { ...panelStyles.dot, ...(row.activity === "running" ? {} : panelStyles.dotIdle) } }),
							react.createElement("span", { style: panelStyles.label }, row.label ?? row.id),
							react.createElement("span", { style: panelStyles.meta }, (row.activity === "running" ? "运行中" : "")),
						);
					}),
				),
				selectedRow !== null ? react.createElement(react.Fragment, null,
					react.createElement("div", { style: panelStyles.transcript },
						messages.length === 0 && !busy ? react.createElement("p", { style: panelStyles.empty }, "暂无消息。") : null,
						messages.map((message, index) => react.createElement("div", {
							key: index,
							style: { ...panelStyles.bubble, ...(message.role === "user" ? panelStyles.bubbleUser : panelStyles.bubbleAssistant) },
						},
							react.createElement("div", { style: panelStyles.role }, message.role === "user" ? "你" : "子代理"),
							message.text,
						)),
					),
					selectedRow.activity === "running" ? react.createElement("p", { style: panelStyles.activity }, "运行中…（每 3 秒自动刷新）") : null,
					selectedRow.activity === "running" ? react.createElement("button", { type: "button", style: panelStyles.button, onClick: () => { void interrupt() } }, "中断") : null,
				) : react.createElement("div", { style: { flex: 1, minHeight: 0 } }),
				// 底部唯一输入框：选中可继续的子会话时=回复它；否则=开新侧聊。
				react.createElement("div", { style: panelStyles.composer },
					react.createElement("input", {
						style: panelStyles.input,
						value: replyMode ? draft : newDraft,
						placeholder: replyMode ? "回复这个侧边会话…" : "直接对话，开始一个新侧聊（纯对话，无工具）…",
						onChange: (event) => { if (replyMode) setDraft(event.target.value); else setNewDraft(event.target.value) },
						onKeyDown: (event) => { if (event.key === "Enter") { if (replyMode) void sendReply(); else void startChat() } },
					}),
					react.createElement("button", { type: "button", style: panelStyles.button, disabled: busy || (replyMode ? draft : newDraft).trim() === "", onClick: () => { if (replyMode) void sendReply(); else void startChat() } }, replyMode ? "发送" : "开始"),
				),
			);
		}

		/** sessionStorage-backed memory of children we already auto-opened
		    (per browser tab, so historical cards never re-trigger the popup). */
		const AUTO_OPEN_KEY = "dsh-upstream-fixes:auto-opened-sidechat";

		function wasAutoOpened(childId) {
			try {
				const raw = window.sessionStorage.getItem(AUTO_OPEN_KEY);
				const list = raw === null ? [] : JSON.parse(raw);
				return Array.isArray(list) && list.includes(childId);
			} catch {
				return false;
			}
		}

		function markAutoOpened(childId) {
			try {
				const raw = window.sessionStorage.getItem(AUTO_OPEN_KEY);
				const parsed = raw === null ? null : JSON.parse(raw);
				const list = Array.isArray(parsed) ? parsed : [];
				if (list.includes(childId)) return;
				list.push(childId);
				if (list.length > 40) list.shift();
				window.sessionStorage.setItem(AUTO_OPEN_KEY, JSON.stringify(list));
			} catch { /* private mode / disabled storage — just skip the memory */ }
		}

		/** Command card for /side and /chat: outcome text plus a sidebar jump.
		    When the card first mounts with a fresh child id it auto-opens the
		    tab and preselects that child (once per child, per browser tab). */
		function SideCommandCard(props) {
			const node = props?.node;
			const outcome = node?.outcome;
			const text = typeof outcome?.text === "string" ? outcome.text : "";
			const childId = CHILD_ID_PATTERN.exec(text)?.[0] ?? null;
			const [jumped, setJumped] = react.useState(false);
			react.useEffect(() => {
				if (childId === null || wasAutoOpened(childId)) return;
				markAutoOpened(childId);
				requestSideChatSelection(childId);
				props.openPanel?.();
			}, []);
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", fontSize: 12 } },
				react.createElement("div", { style: { fontWeight: 600 } }, "/" + (node?.name ?? "") + (node?.input ? " " + node.input : "")),
				text !== "" ? react.createElement("div", { style: { color: outcome?.kind === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)" } }, text) : null,
				childId !== null ? react.createElement("button", {
					type: "button",
					style: panelStyles.button,
					onClick: () => { setJumped(true); requestSideChatSelection(childId); props.openPanel?.(); },
				}, jumped ? "已在侧栏打开" : "在侧栏查看") : null,
			);
		}

		exports.name = "upstream-fixes";
		exports.inject = ["slots", "betterSidebar"];
		exports.apply = function apply(ctx) {
			const service = ctx.get("betterSidebar");
			const openPanel = () => {
				if (service === undefined || typeof service.openTab !== "function") return;
				// A content-seeded open expands a collapsed panel (type-only
				// opens never do) — the path seed is otherwise ignored.
				service.openTab({ type: SIDE_TAB_TYPE, path: SIDE_TAB_PATH });
			};
			// Command cards for /side and /chat.
			for (const key of ["side", "chat"]) {
				ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
					name: "conversation.chat.commandview",
					key,
				}, (props) => SideCommandCard({ ...props, openPanel })));
			}
			// Session-header toggle.
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "sidechat-toggle",
				order: 20,
			}, () => react.createElement("button", {
				type: "button",
				title: "侧边会话 (Ctrl/Cmd+Shift+E)",
				"aria-label": "侧边会话",
				onClick: openPanel,
				style: { font: "inherit", cursor: "pointer", border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary)", padding: "4px 6px", borderRadius: 6, fontSize: 13 },
			}, "侧聊")));
			// Global shortcut: Ctrl/Cmd+Shift+E opens the tab.
			ctx.effect(() => {
				const onKeyDown = (event) => {
					if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "e") {
						event.preventDefault();
						openPanel();
					}
				};
				window.addEventListener("keydown", onKeyDown);
				return () => { window.removeEventListener("keydown", onKeyDown) };
			}, "upstream-fixes: sidechat shortcut");
			// The better-sidebar tab itself (plus the hidden legacy alias so a
			// persisted pre-rename tab recovers instead of orphaning).
			if (service !== undefined && typeof service.registerTab === "function") {
				ctx.effect(() => {
					const disposers = [
						service.registerTab({
							id: SIDE_TAB_TYPE,
							title: "Side chat",
							icon: sideChatIcon,
							order: 90,
							single: true,
							component: SideChatPanel,
						}),
						service.registerTab({
							id: LEGACY_SIDE_TAB_TYPE,
							title: "Side chat",
							icon: sideChatIcon,
							hidden: true,
							single: true,
							component: SideChatPanel,
						}),
					];
					return () => { for (const dispose of disposers) dispose() };
				}, "upstream-fixes: sidechat tab");
			}
		};
		return module.exports;
	},
});
