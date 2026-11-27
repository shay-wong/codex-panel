import { useEffect, useRef, useState } from "react";
import { Box, Button, Callout, Flex, Text } from "@radix-ui/themes";

type AuthStatus = { login: string | null; enabled: boolean };
type DeviceLogin = { userCode: string; verificationUri: string; interval: number; expiresAt: number };
type LoginResult = { status: "pending" | "connected"; interval: number; login: string | null };

export function GitHubLogin() {
  const [login, setLogin] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [device, setDevice] = useState<DeviceLogin | null>(null);
  const [busy, setBusy] = useState("status");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    window.__TAURI__.core.invoke<AuthStatus>("github_auth_status").then(status => {
      if (!cancelled) { setLogin(status.login); setEnabled(status.enabled); }
    }).catch(cause => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setBusy(""); });
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
      if (pending.current) {
        pending.current = false;
        void window.__TAURI__.core.invoke("github_auth_cancel").catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = generation.current;
    function schedule(interval: number) {
      timer = setTimeout(async () => {
        try {
          const result = await window.__TAURI__.core.invoke<LoginResult>("github_auth_poll");
          if (cancelled || current !== generation.current) return;
          if (result.status === "connected") {
            pending.current = false;
            setDevice(null);
            setLogin(result.login);
            setEnabled(true);
            setConnected(true);
          } else schedule(result.interval);
        } catch (cause) {
          if (cancelled || current !== generation.current) return;
          pending.current = false;
          setDevice(null);
          setError(String(cause));
          void window.__TAURI__.core.invoke("github_auth_cancel").catch(() => {});
        }
      }, interval * 1000);
    }
    schedule(device.interval);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [device]);

  async function start() {
    const current = ++generation.current;
    pending.current = true;
    setBusy("start");
    setError("");
    setCopied(false);
    setConnected(false);
    try {
      const next = await window.__TAURI__.core.invoke<DeviceLogin>("github_auth_start");
      if (mounted.current && current === generation.current) setDevice(next);
    } catch (cause) {
      if (mounted.current && current === generation.current) {
        pending.current = false;
        setError(String(cause));
      }
    } finally { if (mounted.current && current === generation.current) setBusy(""); }
  }

  async function cancel() {
    generation.current++;
    pending.current = false;
    setDevice(null);
    setBusy("cancel");
    setError("");
    try { await window.__TAURI__.core.invoke("github_auth_cancel"); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { if (mounted.current) setBusy(""); }
  }

  async function logout() {
    setBusy("logout");
    setError("");
    try {
      const status = await window.__TAURI__.core.invoke<AuthStatus>("github_auth_logout");
      if (mounted.current) { setLogin(status.login); setEnabled(status.enabled); setConnected(false); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { if (mounted.current) setBusy(""); }
  }

  async function copyCode() {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.userCode);
      if (mounted.current) setCopied(true);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
  }

  async function openAuthorization() {
    try { await window.__TAURI__.core.invoke("github_auth_open"); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
  }

  return <Box mt="4" aria-label="GitHub 更新账号">
    <Flex align="center" justify="between" gap="3" wrap="wrap">
      <Box>
        <Text as="div" size="2" weight="medium">GitHub 账号</Text>
        <Text as="p" size="1" color="gray" mt="1" role="status" aria-live="polite">{busy === "status" ? "正在读取登录状态…" : login ? `已登录 @${login}` : enabled ? "已保存 GitHub 登录" : "登录后使用个人 API 额度检查更新"}</Text>
      </Box>
      {enabled
        ? <Button variant="soft" size="2" loading={busy === "logout"} disabled={Boolean(busy)} onClick={() => { void logout(); }}>退出登录</Button>
        : !device && <Button variant="soft" size="2" loading={busy === "start"} disabled={Boolean(busy)} onClick={() => { void start(); }}>登录 GitHub</Button>}
    </Flex>
    {device && <Box mt="3">
      <Text as="p" size="1" color="gray">在 GitHub 授权页输入以下授权码：</Text>
      <Flex align="center" gap="3" mt="2" wrap="wrap">
        <Text as="span" size="4" weight="medium" style={{ fontFamily: "monospace", letterSpacing: "0.08em", userSelect: "text" }}>{device.userCode}</Text>
        <Button size="1" variant="soft" onClick={() => { void copyCode(); }}>{copied ? "已复制" : "复制授权码"}</Button>
      </Flex>
      <Flex align="center" gap="2" mt="3" wrap="wrap">
        <Button size="2" variant="soft" onClick={() => { void openAuthorization(); }}>打开 GitHub 授权页</Button>
        <Button size="2" variant="ghost" disabled={Boolean(busy)} onClick={() => { void cancel(); }}>取消</Button>
        <Text size="1" color="gray" role="status">等待 GitHub 授权…</Text>
      </Flex>
    </Box>}
    {connected && <Text as="p" size="1" color="gray" mt="2">登录成功，现在可以重新检查更新。</Text>}
    {error && <Callout.Root color="red" size="1" role="alert" mt="3"><Callout.Text>{error}</Callout.Text></Callout.Root>}
  </Box>;
}
