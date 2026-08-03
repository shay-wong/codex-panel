# Fork 维护说明

本文档是 `shay-wong/codex-taskboard` 面向维护者和 AI 编码代理的活跃差异台账，只记录相对于 `chuspeeism/dashi-taskboard` 有意保留的行为差异。

## 维护约定

- 新增、修改或移除 Fork 行为时，必须在同一提交中同步对应条目。
- 对外可见的能力在满足仓库的用户确认和测试授权规则后，必须在同一提交中同步功能代码、已授权的针对性测试、中英文 README 入口、英文详细用户文档及索引、`FORK.md` 和 `CHANGELOG.md`。测试未获授权或无法执行时，应如实记录，不得擅自补充。
- 仅面向维护者、构建、合并或内部兼容性的差异只记录在本文档中，除非仓库规则要求其他内部文档。
- 当上游行为和回归覆盖已经等价时，移除对应条目。
- 解决合并冲突时以行为不变量为准，不以整文件归属或同名字段为准。
- 每项能力使用以下生命周期之一：`长期保留` 表示 Fork 特有的产品或策略契约；`等待上游吸收` 表示上游具备等价行为和测试后即可移除的通用修复。
- 每项能力必须记录生命周期、原始目的、行为不变量、代码和测试路径、中英文 README 入口及英文详细用户文档路径，或仅维护者可见的分类、来源提交、合并指引、移除条件和针对性验证方式。

### 文档职责

根级用户入口同时维护英文 `README.md` 和简体中文 `README.zh-CN.md`，两者必须保持功能、命令、默认值和风险说明一致。详细用户指南暂时仅维护英文，位于 `docs/`；中文 README 可以链接到对应英文指南，因此简体中文当前属于详细文档的链接型语言入口。本文档使用中文，负责 Fork 维护和上游合并；`CHANGELOG.md` 使用英文，记录当前对用户可见的 Fork 变更。当公开的 Fork 能力达到多项时，应在 `docs/` 下维护英文能力索引，并从中英文 README 链接过去。

当前没有其他完整维护或链接型语言入口。

## 精确上游基线

- Fork 分支：`main`
- 权威上游：`chuspeeism/dashi-taskboard`
- 上游默认分支：`main`
- GitHub Fork 创建时间：`2026-08-03T14:40:11Z`
- Fork 创建后最近一次上游合并提交：无
- 该合并的上游父提交：不适用
- 精确 Fork 创建基线：`677b54451db707ae6132486b6593b7be11e4ee09`
- 比较范围：`677b54451db707ae6132486b6593b7be11e4ee09..HEAD`

持续移动的 `upstream/main` 是待合并候选，不是本文档的基线。本次审计时，本地 `main`、`origin/main` 和实时查询的 `upstream/main` 均指向上述精确基线。

基线提交本身是一个上游合并提交，父提交分别为 `c9fe427d91e5be1a96b8eae7ec66fa48806379bd` 和 `d02b834d28e6b63b03c3ee3e0c66b65aeb32d56a`。该提交早于本 Fork 创建，不属于“上游合并到 Fork”的提交，两个父提交都不是 Fork 比较基线。

## Fork 发布版本策略

- 权威上游版本来源：精确合并基线中的 `package.json`
- 当前 Fork 版本来源：`package.json` 和 `package-lock.json` 的根包条目
- 精确基线的上游版本：`0.1.0`
- 当前 Fork 版本：`0.1.0`
- 匹配的 Fork 标签或 GitHub Release：无

每个 Fork 发布版本都必须使用 `<upstream-version>-fork.<N>`。上游版本变化时从 `fork.1` 开始；同一上游版本的后续 Fork 发布递增 `N`。已准备但尚未发布的版本号在未被占用时可以保留。

当前不带后缀的 `0.1.0` 不是有效的 Fork 发布版本。下一个规范化 Fork 发布版本是 `0.1.0-fork.1`。不得仅因本次审计而修改版本文件；只能在已授权的发布任务中更新。

## 活跃 Fork 能力

### 使用 Codex Taskboard 产品名

- 生命周期：`长期保留`
- 原始目的：让浏览器标题和中英文仓库入口使用 Fork 项目名 `Codex Taskboard`，避免继续显示上游的通用名称。
- 行为不变量：`web/index.html` 的文档标题以及 `README.md`、`README.zh-CN.md` 的主标题都保持为 `Codex Taskboard`。
- 代码和测试路径：`web/index.html`；该静态标题没有独立自动化测试。
- 用户文档：`README.md` 和 `README.zh-CN.md`；这是命名差异，不需要独立详细指南。
- 来源：Fork 初始定制；可用 `git log -S'<title>Codex Taskboard</title>' -- web/index.html` 定位。
- 合并指引：合并上游 HTML 入口改动时保留 `Codex Taskboard` 标题，除非 Fork 本身再次更名。
- 移除条件：Fork 更名或停止作为独立产品维护时同步更新或移除。
- 针对性验证：运行 `npm run build:web`，并确认 `dist/web/index.html` 包含 `<title>Codex Taskboard</title>`。

### 启动时等待 Codex renderer

- 生命周期：`等待上游吸收`
- 原始目的：修复 Electron 已开放 CDP `/json/version`、但 `/json/list` 尚未出现主 Codex 页面，或头像浮层 renderer 先出现时，独立启动器报错且未完成嵌入的问题。
- 行为不变量：首次注入最多等待 30 秒，排除全局听写和头像浮层等辅助 renderer，并复用找到的主 renderer 完成注入；后续驻留监控仍按原有节奏处理替换后的 renderer。
- 代码和测试路径：`scripts/codex-injector.mjs`、`test/injector.test.mjs`。
- 用户文档：`README.md` 和 `README.zh-CN.md` 的“Embed in Codex”/“嵌入 Codex”章节；两种语言都记录 30 秒等待行为。
- 来源：本次 Fork 修复；可用 `git log -S'waitForCodexTargets' -- scripts/codex-injector.mjs test/injector.test.mjs` 定位。
- 合并指引：若上游重构启动器，必须保留“CDP 就绪不等于主 renderer 就绪”以及“辅助 renderer 不能作为注入目标”的不变量，并用辅助窗口先出现、主窗口延迟出现的检查验证。
- 移除条件：上游实现等价的主 renderer 等待和辅助窗口过滤逻辑，并包含能覆盖该启动顺序的回归测试。
- 针对性验证：运行 `node --test test/injector.test.mjs`，再运行 `CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex` 验证真实首次嵌入。

## 上游合并检查清单

1. 每次实际完成上游合并后，根据 Git 祖先关系重新确定精确基线，不得用持续移动的上游分支头替代。
2. 按能力审计新的 `baseline..HEAD` 范围，以及已暂存、未暂存和未跟踪的工作区变更。
3. 分别审查 `长期保留` 的不变量和 `等待上游吸收` 的候选项；只有上游行为和测试等价后才移除条目。
4. 按行为和不变量解决冲突。只有手工合并结果可能携带 Fork 行为时，才检查 `git show --remerge-diff`。
5. 根据精确合并基线中的上游版本确定下一个发布版本。上游版本变化时使用 `fork.1`；否则递增同一上游版本已发布的最高 Fork 修订号。
6. 仓库规则要求时，从源定义重新生成产物。
7. 在同一提交中同步代码、已授权的测试和 `FORK.md`。公开变更还必须同步中英文 README 入口、英文详细用户文档及索引和 `CHANGELOG.md`。
8. 更新本文档的基线部分，并在完成合并任务前运行针对性验证。

## 明确排除项

- 仓库现有的云端协作、本地 AI 聊天、自动化、Issue 编辑器和 UI 行为在 Fork 创建基线中已属于上游，不是 Fork 差异。
- 仅存在于上游的轻量标签 `pre-cloud-collaboration-2026-07-24` 不是 Fork 发布版本。
- 不含有意 Fork 解决结果的纯上游合并、生成产物噪声、被忽略的本地状态，以及最终效果已被回退的行为都不属于 Fork 能力。
- 尚未合并的上游独有工作属于待合并输入，不属于 Fork 能力。
