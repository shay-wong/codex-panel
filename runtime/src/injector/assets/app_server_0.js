// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(() => new Promise((resolve) => {
        const requestId = __JSON_requestId__;
        const bridge = window.electronBridge;
        if (!bridge || typeof bridge.sendMessageFromView !== "function") {
          resolve({ ok: false, error: "Codex App Server bridge is unavailable" });
          return;
        }
        let settled = false;
        const observed = { responses: 0, matchingId: 0, matchingHost: 0 };
        let sent = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage, true);
          resolve({ ...result, diagnostic: { ...observed, sent, documentReadyState: document.readyState } });
        };
        const onMessage = (event) => {
          const message = event.data;
          if (message?.type === "mcp-response") {
            observed.responses++;
            if (message.message?.id === requestId) observed.matchingId++;
            if (message.hostId === __JSON_hostId__) observed.matchingHost++;
          }
          if (
            !message
            || typeof message !== "object"
            || message.type !== "mcp-response"
            || message.hostId !== __JSON_hostId__
            || message.message?.id !== requestId
          ) return;
          event.stopImmediatePropagation();
          if (message.message.error) {
            finish({
              ok: false,
              error: message.message.error.message || "Codex App Server request failed",
              rpcError: message.message.error,
            });
            return;
          }
          finish({ ok: true, result: message.message.result });
        };
        const timeout = window.setTimeout(
          () => finish({ ok: false, error: "Codex App Server request timed out", failure: "timeout" }),
          __JSON_timeoutMs__,
        );
        window.addEventListener("message", onMessage, true);
        Promise.resolve(bridge.sendMessageFromView({
          type: "mcp-request",
          hostId: __JSON_hostId__,
          request: {
            id: requestId,
            method: __JSON_method__,
            params: __JSON_params__,
          },
          priority: "interactive",
          source: "panel_thread_create",
          timeoutMs: __JSON_timeoutMs__,
          expiresAtMs: Date.now() + __JSON_timeoutMs__,
        })).then(() => { sent = true; }).catch((error) => {
          finish({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }))()
