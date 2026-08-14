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
 */
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
		exports.name = "upstream-fixes";
		exports.inject = [];
		exports.apply = function apply() {};
		return module.exports;
	},
});
