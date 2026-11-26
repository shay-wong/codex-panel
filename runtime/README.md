# Rust 运行时

默认桌面安装包使用 `codex-panel-runtime`，不再包含 Node.js、主机侧 `.mjs` 或 `node_modules`。现有 React 界面和 Codex 渲染器注入资源继续使用 JavaScript；Node.js 只参与源码构建和旧实现差分测试。

运行路径：Tauri → `codex-panel-runtime inject` → 原生 Panel HTTP 服务和 Codex CDP 连接。模型设置、宠物资源、官方更新、共享会话和自动化由同一原生运行时处理。`panelctl` 包装器调用 `codex-panel-runtime ctl`；交接 Skill 调用 `panelctl handoff publish`。

## 构建与验证

需要 Rust 1.88 或更新版本，以及项目规定的 Node.js 前端工具链。

```sh
cargo test --manifest-path runtime/Cargo.toml -- --test-threads=1
npm run app:build:local
npm run app:sign -- 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Codex Panel.app'
node scripts/verify-packaged-taskctl.mjs 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Codex Panel.app'
```

macOS 本地构建优先使用 `CODEX_PANEL_CODESIGN_IDENTITY`，其次为 `APPLE_SIGNING_IDENTITY`；资源准备与 `app:sign` 均允许显式 `-`，未指定时也使用 ad-hoc 签名。两步使用同一身份。构建时先签原生运行时，再计算完整性清单，最终只签启动器和 App，避免重新签名运行时破坏清单。普通构建命令产出的 App 需要完成 `app:sign` 才算签名完成；发布签名策略保持不变。跨架构构建还需安装对应 Rust target。仅编译运行时可用 `cargo build --release --manifest-path runtime/Cargo.toml`。

测试使用临时 HOME、数据目录、工作区和本机模拟服务，不读取日常 Panel 数据或调用真实 Jira。`database_parity` 在两个临时数据库上对照保留的旧 Node 数据层。注入器测试验证静态改写和模拟 CDP，不代表真实 Codex 版本的交互验收。

原生适配由 `src/injector/adapters.rs`、`adapters/cache.rs` 和 `revisions.rs` 按安装包内容及各功能实际源码依赖缓存，失败项重试不清除成功项。最多四个 worker 共用只读源码目录，进度来自实际模块计数；基础连接先就绪，服务完成即应用，界面补丁统一刷新一次，宠物窗口随后复用结果。缓存命中仍计算安装包摘要，完整命中跳过源码提取和分析。

迁移初版曾在 macOS arm64 静态副本上验证 26,210 个模块、九项适配：首次准备约 80.7 秒，持久缓存命中约 0.72 秒，峰值 RSS 约 4.35 GiB，期间有并行编译。这些是补齐逐模块缓存、并发与进度之前的历史观测，不代表当前实现的性能；新一轮 build 30866 完整 ASAR 的十二项冷准备与缓存命中均通过，命中时跳过源码提取和分析；本次 debug 构建及并行编译下观测为首次约 260 秒、命中约 12 秒，不作为发布构建速度承诺。安装验收仍待执行。

完整安装包验收还包括原生签名和资源完整性检查、包内 CLI 在不含 Node 的 PATH 下访问隔离服务，以及真实平台 UI 验收。Windows/Linux 编译、平台运行与正式更新安装需在对应环境分别验证。
