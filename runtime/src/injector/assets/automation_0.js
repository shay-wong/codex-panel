// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(async () => {
      const nativeMethod = {
        "list-automations": "list",
        "automation-create": "create",
        "automation-update": "update",
        "automation-run-now": "runNow",
        "inbox-items": "readHistory",
      }[__JSON_method__];
      let service;
      let load = await (__FIND_REQUIRE__)();
      const runtime = globalThis.__codexPanelRspack__;
      const reference = runtime?.require === load ? runtime.nativeServices?.desktopServices : null;
      const nativeModule = reference ? await runtime.loadModule(reference.id) : null;
      const serviceFromExports = exports => [exports?.appServices, exports, ...Object.values(exports ?? {})]
        .find(value => typeof value?.localAutomations?.[nativeMethod] === "function")?.localAutomations;
      const readService = () => reference ? nativeModule[reference.exportName]?.localAutomations
        : Object.values(load?.c ?? {}).map(module => serviceFromExports(module?.exports)).find(Boolean);
      service = readService();
      if (!service && !reference) {
        const urls = new Set([
          ...Array.from(document.querySelectorAll('script[type="module"][src],link[rel="modulepreload"][href]')).map(node => node.src || node.href),
        ]);
        const current = new URL(location.href);
        for (const url of urls) {
          const parsed = new URL(url, location.href);
          if (parsed.protocol !== current.protocol || parsed.host !== current.host) continue;
          let module;
          try { module = await import(url); } catch { continue; }
          load ??= module.__webpack_require__;
          service = serviceFromExports(module) ?? readService();
          if (service) break;
        }
      }
      if (!service && load) {
        const deadline = Date.now() + 10_000;
        // 首次安装 host bridge 时，已加载模块的服务导出可能仍在异步初始化。
        for (;;) {
          service = readService();
          if (service) break;
          if (Date.now() >= deadline) throw Error("Codex 原生自动任务服务尚未就绪");
          await new Promise(resolve => window.setTimeout(resolve, 50));
        }
      }
      // 新版已移除自动化 fetch handler；写入失败不得回退重试，避免重复变更。
      if (service) {
        const result = await service[nativeMethod](__JSON_params__);
        return { ok: true, status: 200, bodyJsonString: JSON.stringify(result ?? {}) };
      }
      return new Promise((resolve) => {
        const method = __JSON_method__;
        const params = __JSON_params__;
        const requestId = __JSON_requestId__;
        const bridge = window.electronBridge;
        if (!bridge || typeof bridge.sendMessageFromView !== "function") {
          resolve({ ok: false, error: "当前 Codex 版本没有提供原生自动任务能力" });
          return;
        }
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          resolve(result);
        };
        const onMessage = (event) => {
          const message = event.data;
          if (
            !message
            || typeof message !== "object"
            || message.type !== "fetch-response"
            || message.requestId !== requestId
          ) return;
          finish({
            ok: true,
            responseType: message.responseType,
            status: message.status,
            bodyJsonString: message.bodyJsonString,
          });
        };
        const timeout = window.setTimeout(
          () => finish({ ok: false, error: "Codex 自动任务接口没有响应" }),
          10_000,
        );
        window.addEventListener("message", onMessage);
        Promise.resolve(bridge.sendMessageFromView({
          type: "fetch",
          requestId,
          method: "POST",
          url: `vscode://codex/__METHOD_PATH__`,
          body: JSON.stringify(params),
        })).catch((error) => {
          finish({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    })()
