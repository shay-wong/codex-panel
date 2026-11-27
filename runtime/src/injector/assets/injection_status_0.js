// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
({
      version: window.__codexPanelInjection__?.version || null,
      sourceHash: window.__codexPanelInjection__?.sourceHash || null,
      ultrafastBootstrapPrepared: (window.__codexPanelRspack__?.prepared?.ultrafast ?? window.__codexPanelUltrafastBootstrapPrepared__) === true,
      dotBootstrapPrepared: (window.__codexPanelRspack__?.prepared?.dot ?? window.__codexPanelDotBootstrapPrepared__) === true,
      quotaBootstrapPrepared: (window.__codexPanelRspack__?.prepared?.quota ?? window.__codexPanelQuotaBootstrapPrepared__) === true,
      quotaApplied: window.__codexPanelProviderQuotaV1__?.applied === true,
      providerModulesPrepared: (window.__codexPanelRspack__?.prepared?.quota ?? window.__codexPanelProviderQuotaV1__?.prepared) === true,
      nativeAdaptersRevision: window.__codexPanelNativeAdaptersRevision__ || null,
      nativeAdaptersEntryWrapped: window.__codexPanelRspack__ ? window.__codexPanelRspack__.entryWrapped === true : null,
      nativeAdaptersPrepared: window.__codexPanelNativeAdaptersPrepared__ || window.__codexPanelRspack__?.prepared || {},
      threadTabsReady: globalThis.__codexPanelThreadTabsReady__ === true,
      scriptIdentifier: window["__CODEX_PANEL_SCRIPT_IDENTIFIER__"] || null,
      entryMounted: Boolean(document.getElementById("codex-panel-entry")),
      pageMounted: Boolean(document.getElementById("codex-panel-page")),
      pageVisible: document.getElementById("codex-panel-page")?.hidden === false,
      frameReady: window.__codexPanelInjection__?.ready === true,
      heartbeatAt: window.__codexPanelInjection__?.heartbeatAt || null,
      startupToken: window.__codexPanelInjection__?.startupToken || null,
      frameUrl: document.getElementById("codex-panel-frame")?.src || null
    })
