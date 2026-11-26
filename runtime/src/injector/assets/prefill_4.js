// 保留原生页面执行的 JavaScript；主机协议及调度由 Rust 负责。
(() => {
          const instruction = __JSON_instruction__;
          const skills = __JSON_resolvedSkills__;
          const compact = (value) => String(value || "").replace(/\s+/g, "");
          const matchesSkill = (candidate, skill) => {
            const name = candidate.getAttribute("skill-mention-name") || "";
            const skillPath = candidate.getAttribute("skill-mention-path") || "";
            return (name === skill.name || name.endsWith(":" + skill.name))
              && (skillPath === skill.path || skillPath === skill.resolvedPath);
          };
          const editor = Array.from(document.querySelectorAll(
            '[data-codex-composer="true"][contenteditable="true"]'
          )).find((candidate) => candidate.getClientRects().length > 0);
          if (!editor) return false;
          const mentions = Array.from(editor.querySelectorAll("[skill-mention-name]"));
          const skillsMatch = skills.every((skill) => mentions.some((candidate) => (
            matchesSkill(candidate, skill)
          )));
          return skillsMatch && compact(editor.textContent).includes(compact(instruction));
        })()
