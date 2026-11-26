// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(() => {
        const root = Array.from(document.querySelectorAll(
          '[data-codex-composer-root][data-composer-placement="home"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const conversationId = root
          ?.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id')
          ?.trim() || "";
        const editor = Array.from(root?.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        ) || []).find((candidate) => candidate.getClientRects().length > 0);
        if (
          !root
          || conversationId
          || !editor
          || (editor.innerText || "") !== __JSON_instruction__
        ) return false;
        editor.focus();
        return true;
      })()
