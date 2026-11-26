// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(() => !Array.from(document.querySelectorAll(
              '[data-composer-overlay-floating-ui="true"]'
            )).some((candidate) => candidate.getClientRects().length > 0))()
