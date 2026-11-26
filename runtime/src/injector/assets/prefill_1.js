// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(() => {
            const displayName = __JSON_skill_displayName__;
            const overlay = Array.from(document.querySelectorAll(
              '[data-composer-overlay-floating-ui="true"]'
            )).find((candidate) => candidate.getClientRects().length > 0);
            if (!overlay) return { ready: false };
            const button = Array.from(overlay.querySelectorAll(
              'button[data-list-navigation-item="true"]'
            )).find((candidate) => Array.from(candidate.querySelectorAll("span"))
              .some((label) => (label.textContent || "").trim() === displayName));
            if (!button) return { ready: true, found: false };
            button.click();
            return { ready: true, found: true };
          })()
