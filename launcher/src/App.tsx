import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Box, Button, Callout, Card, Dialog, Flex, Heading, IconButton, Separator, Switch, Tabs, Text, Tooltip } from "@radix-ui/themes";
import { LinearIcon } from "../../web/src/components/LinearIcon";

export type LauncherSnapshot = {
  phase: string;
  version: string;
  message: string;
  childPid: number | null;
  embeddedVisible: boolean;
  openRequestPending: boolean;
  updateMessage: string;
  updateAvailable: boolean;
  updateReady: boolean;
  appPath: string | null;
};
export type LauncherPreferences = { autoConnectCodex: boolean; autoOpenPanel: boolean; hideUsageBanner: boolean };
export type LauncherState = {
  snapshot: LauncherSnapshot;
  preferences: LauncherPreferences;
  autostart: boolean;
  dataDirectory: string;
  logPath: string;
};
export type TauriBridge = {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<() => void> };
};
declare global { interface Window { __TAURI__: TauriBridge } }

const labels: Record<string, string> = { running: "运行正常", waiting: "等待 Codex", error: "运行异常", stopped: "已停止", starting: "启动中" };
const titles: Record<string, string> = { running: "Panel 已就绪", waiting: "服务已启动", error: "服务需要处理", stopped: "服务已停止", starting: "正在建立连接" };
const initialSnapshot: LauncherSnapshot = {
  phase: "starting", version: "—", message: "正在读取服务状态…", childPid: null,
  embeddedVisible: false, openRequestPending: false, updateMessage: "尚未检查更新。",
  updateAvailable: false, updateReady: false, appPath: null,
};

function Setting({ id, title, detail, checked, disabled, onChange }: {
  id: string; title: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  return <Flex className={`preference-row${disabled ? " is-disabled" : ""}`} align="center" justify="between" gap="4">
    <Box><Text as="label" htmlFor={id} size="2" weight="medium">{title}</Text><Text as="p" size="1" color="gray" mt="1" id={`${id}Detail`}>{detail}</Text></Box>
    <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-describedby={`${id}Detail`} highContrast size="1" />
  </Flex>;
}

export function App() {
  const [state, setState] = useState<LauncherState | null>(null);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [feedback, setFeedback] = useState<Record<string, "success" | "failed">>({});
  const [savingPreference, setSavingPreference] = useState(false);
  const [workflowUrl, setWorkflowUrl] = useState("");
  const [view, setView] = useState("overview");
  const workflowFrame = useRef<HTMLIFrameElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const feedbackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const busy = Boolean(busyAction);
  const preferences = state?.preferences;
  const hasProcess = snapshot.childPid !== null && snapshot.childPid !== undefined;
  const ready = snapshot.phase === "running";
  const needsStart = snapshot.phase === "stopped" || snapshot.phase === "error";
  const opening = !needsStart && snapshot.openRequestPending && ready;
  const queued = !needsStart && snapshot.openRequestPending && !ready;

  function acceptState(next: LauncherState) {
    setState(next);
    setSnapshot(next.snapshot);
    if (next.snapshot.phase === "error") setError(next.snapshot.message);
  }

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const timers = feedbackTimers.current;
    window.__TAURI__.core.invoke<LauncherState>("launcher_ui_state").then(next => {
      if (!cancelled) acceptState(next);
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    window.__TAURI__.event.listen<LauncherSnapshot>("launcher-status", event => {
      if (cancelled) return;
      setSnapshot(event.payload);
      if (event.payload.phase === "error") setError(event.payload.message);
    }).then(stop => { if (cancelled) stop(); else unlisten = stop; })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    function onKey(event: KeyboardEvent) {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        primaryButton.current?.click();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      unlisten?.();
      document.removeEventListener("keydown", onKey);
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (!workflowUrl) return;
    function onMessage(event: MessageEvent) {
      if (event.source === workflowFrame.current?.contentWindow && event.origin === new URL(workflowUrl).origin
        && event.data?.type === "panel:workflow-settings-close") setWorkflowUrl("");
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [workflowUrl]);

  async function run(action: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction(action);
    setError("");
    const started = performance.now();
    let succeeded = false;
    let failure: unknown;
    try {
      if (action === "workflow_settings_url") {
        setWorkflowUrl(await window.__TAURI__.core.invoke<string>(action));
      } else {
        const result = await window.__TAURI__.core.invoke<LauncherState | undefined>(action);
        acceptState(result?.snapshot ? result : await window.__TAURI__.core.invoke<LauncherState>("launcher_ui_state"));
      }
      succeeded = true;
    } catch (cause) { failure = cause; }
    finally {
      const remaining = 300 - (performance.now() - started);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      busyRef.current = false;
      setBusyAction("");
      if (!succeeded) setError(String(failure));
      clearTimeout(feedbackTimers.current.get(action));
      setFeedback(current => ({ ...current, [action]: succeeded ? "success" : "failed" }));
      feedbackTimers.current.set(action, setTimeout(() => {
        setFeedback(current => { const next = { ...current }; delete next[action]; return next; });
        feedbackTimers.current.delete(action);
      }, 900));
    }
  }

  async function savePreference(key: keyof LauncherPreferences | "autostart", enabled: boolean) {
    setError("");
    setSavingPreference(true);
    try {
      if (key === "autostart") {
        const autostart = await window.__TAURI__.core.invoke<boolean>("set_autostart", { enabled });
        setState(current => current && ({ ...current, autostart }));
      } else {
        const next = await window.__TAURI__.core.invoke<LauncherPreferences>("set_launcher_preference", { key, enabled });
        setState(current => current && ({ ...current, preferences: next }));
      }
    } catch (cause) { setError(String(cause)); }
    finally { setSavingPreference(false); }
  }

  function actionProps(action: string, disabled = false) {
    return {
      "data-action": action,
      disabled: busy || disabled,
      loading: busyAction === action,
      "aria-busy": busyAction === action || undefined,
      className: busyAction === action ? "is-busy" : feedback[action] ? `is-${feedback[action]}` : undefined,
      onClick: () => { void run(action); },
    };
  }
  function iconAction(id: string, action: string, title: string, icon: ReactNode, disabled = false) {
    return <Tooltip content={title}><IconButton id={id} aria-label={title} variant="ghost" size="2" {...actionProps(action, disabled)}>{icon}</IconButton></Tooltip>;
  }

  const componentStates = [
    { id: "panel", label: "Panel 服务", text: snapshot.phase === "error" ? "启动异常" : hasProcess ? `运行中 · PID ${snapshot.childPid}` : "未启动", tone: snapshot.phase === "error" ? "error" : hasProcess ? "running" : "stopped" },
    { id: "codex", label: "Codex 连接", text: snapshot.phase === "error" ? "连接失败" : ready ? "连接已就绪" : hasProcess ? "正在等待连接" : "未连接", tone: snapshot.phase === "error" ? "error" : ready ? "running" : hasProcess ? "waiting" : "stopped" },
    { id: "embedded", label: "内嵌面板", text: snapshot.embeddedVisible ? "已在 Codex 中打开" : opening ? "正在打开" : queued ? "等待连接后打开" : ready ? "可以打开" : "尚未就绪", tone: snapshot.embeddedVisible ? "running" : opening || queued ? "waiting" : ready ? "available" : "stopped" },
  ];

  return <div className={`launcher${busy ? " busy" : ""}`}>
    <Tabs.Root value={view} onValueChange={setView} orientation="vertical" className="launcher-layout">
      <aside className="launcher-sidebar">
        <Flex align="center" gap="2" className="launcher-brand">
          <picture aria-hidden="true"><source srcSet="icon-dark.png" media="(prefers-color-scheme: dark)" /><img className="brand-icon" src="icon-light.png" alt="" /></picture>
          <Box><Heading size="3" as="h1">Panel</Heading><Text size="1" color="gray">Codex</Text></Box>
        </Flex>
        <Tabs.List aria-label="启动器页面" highContrast size="2" className="launcher-navigation">
          <Tabs.Trigger value="overview"><LinearIcon name="home" />运行概览</Tabs.Trigger>
          <Tabs.Trigger value="preferences"><LinearIcon name="settings" />偏好设置</Tabs.Trigger>
          <Tabs.Trigger value="about"><LinearIcon name="file" />关于</Tabs.Trigger>
        </Tabs.List>
        <div className="sidebar-footer">
          <Button id="primaryAction" ref={primaryButton} highContrast {...actionProps("open_embedded_panel", opening || queued)}>
            <LinearIcon name="panel" />{needsStart ? "启动并打开" : opening ? "正在打开…" : queued ? "等待连接" : "打开面板"}
          </Button>
        </div>
      </aside>
    <main className="launcher-main">
      <header className="page-heading">
        <Box><Heading as="h2" size="5">{view === "overview" ? "运行概览" : view === "preferences" ? "偏好设置" : "关于"}</Heading><Text as="p" size="1" color="gray" mt="1">{view === "overview" ? "管理本机服务与 Codex 连接" : view === "preferences" ? "所有项目共用的工作流与使用偏好" : "应用信息与版本更新"}</Text></Box>
        {iconAction("refresh", "launcher_ui_state", "刷新状态", <span className="refresh-icon" aria-hidden="true">↻</span>)}
      </header>
      {error && <Callout.Root id="errorNotice" color="red" size="1" role="alert" mb="4">
        <Callout.Icon><LinearIcon name="alert" /></Callout.Icon>
        <Callout.Text id="errorText" className="launcher-error">{error}</Callout.Text>
        <IconButton id="dismissError" variant="ghost" color="red" size="1" aria-label="关闭提示" onClick={() => setError("")}><LinearIcon name="close" /></IconButton>
      </Callout.Root>}
          <Tabs.Content value="overview" id="overviewView">
            <section className="status-panel">
              <Flex align="center" gap="3">
                <div className={`status-symbol ${snapshot.phase}`}><LinearIcon name={snapshot.phase === "error" ? "alert" : ready ? "check" : "terminal"} /></div>
                <Box>
                  <Badge id="status" variant="soft" color={snapshot.phase === "error" ? "red" : "gray"} size="1" mb="2"><span id="statusText">{labels[snapshot.phase] || "启动中"}</span></Badge>
                  <Heading id="overviewTitle" as="h3" size="4">{titles[snapshot.phase] || "正在建立连接"}</Heading>
                </Box>
              </Flex>
                  <Text as="p" id="message" size="2" color="gray" mt="2" aria-live="polite">{snapshot.message}</Text>
              <Flex className="lifecycle-actions" align="center" gap="2" wrap="wrap" mt="4" aria-label="服务控制">
                <Button id="serviceToggle" variant="soft" {...actionProps(hasProcess ? "stop_service" : "start_service")}><LinearIcon name={hasProcess ? "pause" : "play"} />{hasProcess ? "停止服务" : "启动服务"}</Button>
                <Button id="restartService" variant="ghost" {...actionProps("reconnect_codex", !hasProcess)}>重启</Button>
                <Button id="browserPanel" variant="ghost" {...actionProps("open_browser_panel", !hasProcess)}>在浏览器中打开<LinearIcon name="openExternal" /></Button>
              </Flex>
            </section>
            <div className="status-card-grid" aria-label="组件状态">{componentStates.map(component => <div className={`status-card ${component.tone}`} key={component.id} id={`${component.id}Component`}>
              <Flex align="center" justify="between" gap="3"><Text size="1" color="gray">{component.label}</Text><span className={`status-dot ${component.tone}`} /></Flex>
              <Text id={`${component.id}Status`} as="div" size="2" weight="medium" mt="3">{component.text}</Text>
            </div>)}</div>
            <Box mt="4">
              <Flex gap="2" wrap="wrap">
                <Button variant="outline" {...actionProps("open_log")}>运行日志</Button>
                <Button variant="outline" {...actionProps("reveal_data")}>数据目录</Button>
              </Flex>
            </Box>
            <details className="runtime-details"><summary>运行详情</summary><div className="runtime-grid">{[
              ["appPath", "Codex 应用", snapshot.appPath || "尚未检测"],
              ["childPid", "服务进程", hasProcess ? `PID ${snapshot.childPid}` : "尚未启动"],
              ["dataDirectory", "数据目录", state?.dataDirectory || "正在读取"],
              ["logPath", "运行日志", state?.logPath || "正在读取"],
            ].map(([id, label, value]) => <Box key={id}><Text as="div" size="1" color="gray">{label}</Text><code id={id} title={value}>{value}</code></Box>)}</div></details>
          </Tabs.Content>
          <Tabs.Content value="preferences" id="preferencesView">
            <section className="preference-section" aria-labelledby="workflowTitle">
              <Card className="workflow-entry"><Flex className="preference-row" align="center" justify="between" gap="3"><Box><Heading as="h3" size="2" id="workflowTitle">全局工作流</Heading><Text as="p" id="workflowDetail" size="1" color="gray" mt="1">{hasProcess ? "选择规划、执行、审核与交接的 Skill" : "启动 Panel 服务后可配置"}</Text></Box><Button id="configureWorkflows" variant="soft" {...actionProps("workflow_settings_url", !hasProcess)}>配置工作流<LinearIcon name="chevronRight" /></Button></Flex></Card>
            </section>
            <section className="preference-section" aria-labelledby="connectionTitle">
              <Heading as="h2" size="2" id="connectionTitle" mb="2">连接行为</Heading>
              <div className="preference-rows">
                <Setting id="autoConnectCodex" title="启动时连接 Codex" detail="打开启动器时，自动连接 Codex" checked={preferences?.autoConnectCodex ?? false} disabled={!state || savingPreference} onChange={enabled => void savePreference("autoConnectCodex", enabled)} />
                <Separator size="4" />
                <Setting id="autoOpenPanel" title="连接后打开任务面板" detail={preferences?.autoConnectCodex ? "连接就绪后自动显示 Panel" : "需先开启“启动时连接 Codex”"} checked={preferences?.autoOpenPanel ?? false} disabled={!preferences?.autoConnectCodex || savingPreference} onChange={enabled => void savePreference("autoOpenPanel", enabled)} />
              </div>
            </section>
            <section className="preference-section" aria-labelledby="displayTitle">
              <Heading as="h2" size="2" id="displayTitle" mb="2">显示与系统</Heading>
              <div className="preference-rows">
                <Setting id="hideUsageBanner" title="隐藏额度耗尽提示" detail="收起对话中的额度横幅，不改变实际额度" checked={preferences?.hideUsageBanner ?? false} disabled={!state || savingPreference} onChange={enabled => void savePreference("hideUsageBanner", enabled)} />
                <Separator size="4" />
                <Setting id="autostart" title="登录时启动" detail="登录电脑后自动运行 Codex Panel" checked={state?.autostart ?? false} disabled={!state || savingPreference} onChange={enabled => void savePreference("autostart", enabled)} />
              </div>
            </section>
          </Tabs.Content>
          <Tabs.Content value="about" id="aboutView">
            <Flex align="center" gap="4" mb="5">
              <picture aria-hidden="true"><source srcSet="icon-dark.png" media="(prefers-color-scheme: dark)" /><img width="52" height="52" src="icon-light.png" alt="" /></picture>
              <Box><Heading as="h3" size="5">Codex Panel</Heading><Text as="p" id="version" size="2" color="gray" mt="2">版本 {snapshot.version}</Text></Box>
            </Flex>
            <Text as="p" size="2" color="gray">在 Codex 中管理任务与工作流。</Text>
            <Separator size="4" my="5" />
            <Flex justify="between" align="center" mb="3"><Heading as="h3" size="2">版本更新</Heading>{snapshot.updateAvailable && <Badge id="updateBadge">有新版本</Badge>}</Flex>
            <Text as="p" size="2" color="gray" mb="4" id="updateMessage">{snapshot.updateMessage || "尚未检查更新。"}</Text>
            <Flex gap="2" wrap="wrap">
              <Button variant="soft" {...actionProps("check_for_updates")}>检查更新</Button>
              {snapshot.updateReady && <Button id="installUpdate" highContrast {...actionProps("install_available_update")}>安装并重启</Button>}
              {snapshot.updateAvailable && <Button id="openRelease" variant="soft" {...actionProps("open_available_release")}>查看发布说明</Button>}
            </Flex>
          </Tabs.Content>
    </main>
    </Tabs.Root>
    <Dialog.Root open={Boolean(workflowUrl)} onOpenChange={open => { if (!open) setWorkflowUrl(""); }}>
      <Dialog.Content className="workflow-dialog" aria-describedby={undefined}>
        <Dialog.Title className="visually-hidden">全局工作流设置</Dialog.Title>
        {workflowUrl && <iframe ref={workflowFrame} id="workflowFrame" src={workflowUrl} title="全局工作流设置" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" />}
      </Dialog.Content>
    </Dialog.Root>
  </div>;
}

export default App;
