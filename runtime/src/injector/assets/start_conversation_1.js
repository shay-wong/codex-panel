// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(() => {
          const root = Array.from(document.querySelectorAll(
            '[data-codex-composer-root][data-composer-placement="thread"]'
          )).find((candidate) => candidate.getClientRects().length > 0);
          const threadId = root
            ?.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id')
            ?.trim() || "";
          return threadId.replace(/^(?:local|cloud):/i, "");
        })()
