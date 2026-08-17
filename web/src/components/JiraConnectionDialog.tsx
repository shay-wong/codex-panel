import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { JiraConnection } from "../types";

interface JiraConnectionDialogProps {
  connection: JiraConnection | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: {
    baseUrl: string;
    authMethod: "basic" | "bearer";
    username: string;
    password: string;
    projects: string[];
  }) => Promise<void>;
}

export function JiraConnectionDialog({
  connection,
  saving,
  error,
  onClose,
  onSave,
}: JiraConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "http://");
  const [authMethod, setAuthMethod] = useState<"basic" | "bearer">(
    connection?.authMethod ?? "basic",
  );
  const [username, setUsername] = useState(connection?.username ?? "");
  const [password, setPassword] = useState("");
  const [projectsText, setProjectsText] = useState(connection?.projects.join(", ") ?? "");

  useEffect(() => {
    setBaseUrl(connection?.baseUrl ?? "http://");
    setAuthMethod(connection?.authMethod ?? "basic");
    setUsername(connection?.username ?? "");
    setPassword("");
    setProjectsText(connection?.projects.join(", ") ?? "");
  }, [connection]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({
      baseUrl: baseUrl.trim(),
      authMethod,
      username: authMethod === "basic" ? username.trim() : "",
      password,
      projects: projectsText
        .split(/[,，\n]+/)
        .map((project) => project.trim())
        .filter(Boolean),
    });
  }

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="delete-dialog project-create-dialog jira-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jira-connection-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="jira-connection-title">
          {connection?.configured ? text("Jira 设置", "Jira settings") : text("连接 Jira", "Connect Jira")}
        </h2>
        <label>
          <span>{text("Jira 地址", "Jira URL")}</span>
          <input
            autoFocus
            required
            inputMode="url"
            maxLength={2048}
            placeholder="http://jira.internal"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        {/^http:\/\//i.test(baseUrl.trim()) && (
          <p className="jira-http-warning">
            {text(
              "HTTP 会在网络中以可读取形式传输认证凭据。",
              "HTTP sends authentication credentials in cleartext over the network.",
            )}
          </p>
        )}
        <fieldset className="jira-auth-method">
          <legend>{text("认证方式", "Authentication")}</legend>
          <div role="radiogroup" aria-label={text("Jira 认证方式", "Jira authentication method")}>
            <button
              type="button"
              role="radio"
              aria-checked={authMethod === "basic"}
              className={authMethod === "basic" ? "is-active" : undefined}
              onClick={() => setAuthMethod("basic")}
            >
              {text("账号 / API Token", "Account / API token")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={authMethod === "bearer"}
              className={authMethod === "bearer" ? "is-active" : undefined}
              onClick={() => setAuthMethod("bearer")}
            >
              {text("Bearer Token", "Bearer token")}
            </button>
          </div>
        </fieldset>
        <label>
          <span>{text("Jira 项目（名称或 Key，可多选）", "Jira projects (name or key, multiple allowed)")}</span>
          <input
            maxLength={2600}
            placeholder="DMARTECH, JP"
            value={projectsText}
            onChange={(event) => setProjectsText(event.target.value)}
          />
        </label>
        {authMethod === "basic" && (
          <label>
            <span>{text("用户名或邮箱", "Username or email")}</span>
            <input
              required={!connection?.configured || connection.authMethod !== "basic"}
              autoComplete="username"
              maxLength={254}
              placeholder={connection?.configured && connection.authMethod === "basic"
                ? text("留空则保持不变", "Leave blank to keep unchanged")
                : ""}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
        )}
        <label>
          <span>{authMethod === "basic"
            ? text("密码或 API Token", "Password or API token")
            : text("Personal Access Token", "Personal access token")}</span>
          <input
            required={!connection?.configured || connection.authMethod !== authMethod}
            type="password"
            autoComplete="current-password"
            maxLength={4096}
            placeholder={connection?.configured ? text("留空则保持不变", "Leave blank to keep unchanged") : ""}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {connection?.configured && connection.displayName && (
          <p>{text("当前账号：", "Current account: ")}{connection.displayName}</p>
        )}
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              saving
              || !baseUrl.trim()
              || (
                authMethod === "basic"
                && !username.trim()
                && (!connection?.configured || connection.authMethod !== "basic")
              )
              || (!password && (!connection?.configured || connection.authMethod !== authMethod))
            }
          >
            {saving
              ? text("连接中…", "Connecting…")
              : connection?.configured
                ? text("保存并同步", "Save and sync")
                : text("连接并同步", "Connect and sync")}
          </button>
        </div>
      </form>
    </div>
  );
}
