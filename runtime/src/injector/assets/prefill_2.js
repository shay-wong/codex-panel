// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(() => {
            const skillName = __JSON_skill_name__;
            const skillPath = __JSON_skill_path__;
            const resolvedPath = __JSON_skill_resolvedPath__;
            const editor = Array.from(document.querySelectorAll(
              '[data-codex-composer="true"][contenteditable="true"]'
            )).find((candidate) => candidate.getClientRects().length > 0);
            if (!editor) return { ready: false };
            const selected = Array.from(editor.querySelectorAll("[skill-mention-name]"))
              .find((candidate) => {
                const name = candidate.getAttribute("skill-mention-name") || "";
                return name === skillName || name.endsWith(":" + skillName);
              });
            return {
              ready: Boolean(selected),
              pathMatches: [skillPath, resolvedPath].includes(
                selected?.getAttribute("skill-mention-path") || ""
              ),
            };
          })()
