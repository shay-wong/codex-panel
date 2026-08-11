import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  createJiraProvider,
  deleteJiraProvider,
  discoverJiraConfigs,
  listJiraProviders,
  updateJiraProvider,
} from "../api";
import type {
  JiraAutomationOperation,
  JiraConfigSuggestion,
  JiraProvider,
  JiraProviderDraft,
} from "../types";
import { LinearIcon } from "./LinearIcon";

const DEFAULT_JQL = "assignee = currentUser() AND resolution IS EMPTY";

const EMPTY_DRAFT: JiraProviderDraft = {
  key: "",
  alias: "",
  configPath: "",
  jql: DEFAULT_JQL,
  enabled: true,
  preview: true,
  autoComplete: false,
  completionStatus: null,
};

interface JiraProviderSettingsProps {
  open: boolean;
  automationAvailable: boolean;
  onAutomationRequest: (
    provider: JiraProvider,
    operation: JiraAutomationOperation,
  ) => Promise<{
    item?: { id: string; status: "ACTIVE" | "PAUSED" };
    state?: "normal" | "drifted" | "missing";
    run?: "started" | "already-running" | "disabled" | "drifted";
  }>;
  onClose: () => void;
}

type JiraAutomationResponse = Awaited<ReturnType<JiraProviderSettingsProps["onAutomationRequest"]>>;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "操作未完成，请重试。";
}

function draftFromProvider(provider: JiraProvider): JiraProviderDraft {
  return {
    key: provider.key,
    alias: provider.alias,
    configPath: provider.configPath,
    jql: provider.jql,
    enabled: provider.enabled,
    preview: provider.preview,
    autoComplete: provider.autoComplete,
    completionStatus: provider.completionStatus,
  };
}

function draftFromSuggestion(
  suggestion: JiraConfigSuggestion,
  providers: JiraProvider[],
): JiraProviderDraft {
  const providerKeys = new Set(providers.map((provider) => provider.key));
  let key = suggestion.key;
  for (let suffix = 2; providerKeys.has(key); suffix += 1) key = `${suggestion.key}-${suffix}`;
  return {
    ...EMPTY_DRAFT,
    key,
    alias: suggestion.alias,
    configPath: suggestion.configPath,
  };
}

function firstUnconfiguredSuggestion(
  suggestions: JiraConfigSuggestion[],
  providers: JiraProvider[],
): JiraConfigSuggestion | null {
  return suggestions.find((suggestion) => (
    !providers.some((provider) => provider.configPath === suggestion.configPath)
  )) ?? null;
}

function ToggleRow({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="jira-provider-toggle-row">
      <span>{label}</span>
      <button
        className={`board-setting-switch${value ? " is-on" : ""}`}
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!value)}
      >
        <span />
      </button>
    </div>
  );
}

export function JiraProviderSettings({
  open,
  automationAvailable,
  onAutomationRequest,
  onClose,
}: JiraProviderSettingsProps) {
  const [providers, setProviders] = useState<JiraProvider[]>([]);
  const [configSuggestions, setConfigSuggestions] = useState<JiraConfigSuggestion[]>([]);
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<JiraProviderDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationState, setAutomationState] = useState<"normal" | "drifted" | "missing" | null>(null);
  const [automationStatus, setAutomationStatus] = useState<"ACTIVE" | "PAUSED" | null>(null);
  const [automationNotice, setAutomationNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const automationRequestSequence = useRef(0);
  const selected = providers.find((provider) => provider.key === selectedKey) ?? null;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setDiscoveryComplete(false);
    setError(null);
    void (async () => {
      try {
        const [loadedItems, suggestions] = await Promise.all([
          listJiraProviders(controller.signal),
          discoverJiraConfigs(controller.signal).catch((discoveryError) => {
            if ((discoveryError as Error).name === "AbortError") throw discoveryError;
            return [];
          }),
        ]);
        const items = [...loadedItems];
        let automationLoadError: string | null = null;
        if (automationAvailable) {
          for (let index = 0; index < items.length; index += 1) {
            const provider = items[index];
            if (!provider.enabled || provider.scheduledTaskId) continue;
            try {
              const response = await onAutomationRequest(provider, "ensure-active");
              if (response.item) {
                items[index] = await updateJiraProvider(provider, {
                  scheduledTaskId: response.item.id,
                });
              }
            } catch (automationError) {
              automationLoadError ??= errorMessage(automationError);
            }
          }
        }
        if (controller.signal.aborted) return;
        setProviders(items);
        setConfigSuggestions(suggestions);
        setDiscoveryComplete(true);
        const first = items[0] ?? null;
        const suggestion = firstUnconfiguredSuggestion(suggestions, items);
        selectedKeyRef.current = first?.key ?? null;
        setSelectedKey(first?.key ?? null);
        setDraft(first
          ? draftFromProvider(first)
          : suggestion ? draftFromSuggestion(suggestion, items) : EMPTY_DRAFT);
        setError(automationLoadError);
        setLoading(false);
        if (first) void inspectAutomation(first);
      } catch (loadError) {
        if ((loadError as Error).name === "AbortError") return;
        setError(errorMessage(loadError));
        setDiscoveryComplete(true);
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [automationAvailable, onAutomationRequest, open]);

  if (!open) return null;

  function selectProvider(provider: JiraProvider) {
    selectedKeyRef.current = provider.key;
    setSelectedKey(provider.key);
    setDraft(draftFromProvider(provider));
    setError(null);
    setAutomationNotice(null);
    void inspectAutomation(provider);
  }

  function createNew() {
    const suggestion = firstUnconfiguredSuggestion(configSuggestions, providers);
    automationRequestSequence.current += 1;
    selectedKeyRef.current = null;
    setSelectedKey(null);
    setDraft(suggestion ? draftFromSuggestion(suggestion, providers) : EMPTY_DRAFT);
    setError(null);
    setAutomationState(null);
    setAutomationStatus(null);
    setAutomationNotice(null);
    setAutomationPending(false);
  }

  function replaceProvider(provider: JiraProvider) {
    setProviders((current) => (
      current.some((item) => item.key === provider.key)
        ? current.map((item) => item.key === provider.key ? provider : item)
        : [...current, provider]
    ));
    if (selectedKeyRef.current === provider.key) setDraft(draftFromProvider(provider));
  }

  function storeProvider(provider: JiraProvider) {
    selectedKeyRef.current = provider.key;
    setSelectedKey(provider.key);
    replaceProvider(provider);
  }

  async function persistAutomation(
    provider: JiraProvider,
    response: JiraAutomationResponse,
  ): Promise<JiraProvider> {
    if (!response.item || response.item.id === provider.scheduledTaskId) return provider;
    const saved = await updateJiraProvider(provider, { scheduledTaskId: response.item.id });
    replaceProvider(saved);
    return saved;
  }

  async function requestAutomation(
    provider: JiraProvider,
    operation: JiraAutomationOperation,
    persistTaskId = true,
  ): Promise<JiraAutomationResponse | null> {
    const requestSequence = ++automationRequestSequence.current;
    const isCurrent = () => (
      automationRequestSequence.current === requestSequence
      && selectedKeyRef.current === provider.key
    );
    if (!automationAvailable) {
      if (isCurrent()) {
        setAutomationState(null);
        setAutomationStatus(null);
        setAutomationNotice("Scheduled Task 只能在 Codex Panel.app 中管理");
      }
      return null;
    }
    if (isCurrent()) {
      setAutomationPending(true);
      setAutomationNotice(null);
      if (operation !== "list") setError(null);
    }
    try {
      const response = await onAutomationRequest(provider, operation);
      if (persistTaskId && isCurrent()) await persistAutomation(provider, response);
      if (isCurrent()) {
        if (response.state !== undefined) setAutomationState(response.state);
        if (response.item) setAutomationStatus(response.item.status);
        if (response.run === "started") setAutomationNotice("已开始同步");
        if (response.run === "already-running") setAutomationNotice("该 provider 已有同步正在运行");
        if (response.run === "disabled") setAutomationNotice("请先启用 provider");
        if (response.run === "drifted") setAutomationNotice("任务已被外部修改，请先恢复标准任务");
      }
      return response;
    } catch (automationError) {
      if (isCurrent()) setError(errorMessage(automationError));
      return null;
    } finally {
      if (isCurrent()) setAutomationPending(false);
    }
  }

  async function inspectAutomation(provider: JiraProvider) {
    setAutomationState(null);
    setAutomationStatus(null);
    await requestAutomation(provider, "list");
  }

  async function saveProvider() {
    if (saving || automationPending) return;
    setSaving(true);
    setError(null);
    try {
      let normalized: JiraProviderDraft = {
        ...draft,
        key: draft.key.trim(),
        alias: draft.alias.trim(),
        configPath: draft.configPath.trim(),
        jql: draft.jql.trim(),
        completionStatus: draft.completionStatus?.trim() || null,
      };
      if (selected && normalized.jql !== selected.jql && !normalized.preview) {
        normalized = {
          ...normalized,
          preview: window.confirm(
            "JQL 已修改。是否重新开启预览同步？\n\n选择“取消”将保持关闭并继续保存。",
          ),
        };
      }
      const { key: _key, ...changes } = normalized;
      const saved = selected
        ? await updateJiraProvider(selected, changes)
        : await createJiraProvider(normalized);
      storeProvider(saved);
      const scheduleChanged = selected ? (
        saved.alias !== selected.alias
        || saved.configPath !== selected.configPath
        || saved.jql !== selected.jql
        || saved.enabled !== selected.enabled
      ) : false;
      const operation = !saved.enabled
        ? "pause"
        : scheduleChanged && automationState === "normal"
          ? "restore"
          : "ensure-active";
      await requestAutomation(saved, operation);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function removeProvider() {
    if (!selected || saving || automationPending) return;
    if (!window.confirm(`删除 Jira provider“${selected.alias}”？`)) return;
    setSaving(true);
    setError(null);
    try {
      if (automationAvailable) {
        const response = await requestAutomation(selected, "pause", false);
        if (!response) return;
      } else if (selected.scheduledTaskId) {
        throw new Error("请在 Codex Panel.app 中删除，以便先停用 Scheduled Task");
      }
      await deleteJiraProvider(selected);
      const remaining = providers.filter((provider) => provider.key !== selected.key);
      const next = remaining[0] ?? null;
      selectedKeyRef.current = next?.key ?? null;
      setProviders(remaining);
      setSelectedKey(next?.key ?? null);
      setDraft(next ? draftFromProvider(next) : EMPTY_DRAFT);
      setAutomationState(null);
      setAutomationStatus(null);
      setAutomationNotice(null);
      if (next) void inspectAutomation(next);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setSaving(false);
    }
  }

  const canSave = Boolean(
    draft.key.trim()
    && draft.alias.trim()
    && draft.configPath.trim()
    && draft.jql.trim()
    && (!draft.autoComplete || draft.completionStatus?.trim()),
  );
  const detectedConfig = configSuggestions.some((suggestion) => (
    suggestion.configPath === draft.configPath
  ));
  const automationLabel = !automationAvailable
    ? "仅限 Panel.app"
    : automationState === "drifted"
      ? "已被外部修改"
      : automationState === "missing"
        ? "未找到"
        : automationState === "normal"
          ? automationStatus === "ACTIVE" ? "正常运行" : "已暂停"
          : "正在检查";

  return (
    <div
      className="delete-backdrop jira-provider-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="jira-provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jira-provider-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <header>
          <h2 id="jira-provider-title">Jira providers</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭 Jira 设置"
            disabled={saving}
            onClick={onClose}
          >
            <LinearIcon name="close" />
          </button>
        </header>

        <div className="jira-provider-layout">
          <aside aria-label="Jira providers">
            <button className="jira-provider-add" type="button" onClick={createNew}>
              <LinearIcon name="createIssue" />
              <span>新增 provider</span>
            </button>
            {loading ? (
              <p>正在载入…</p>
            ) : providers.map((provider) => (
              <button
                className={provider.key === selectedKey ? "is-selected" : ""}
                type="button"
                key={provider.key}
                onClick={() => selectProvider(provider)}
              >
                <strong>{provider.alias}</strong>
                <small>{provider.key}</small>
                <span className={`jira-provider-state${provider.enabled ? " is-enabled" : ""}`}>
                  {provider.enabled ? "已启用" : "已停用"}
                </span>
              </button>
            ))}
          </aside>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveProvider();
            }}
          >
            <div className="jira-provider-fields">
              <label>
                <span>Provider key</span>
                <input
                  autoFocus={!selected}
                  value={draft.key}
                  disabled={Boolean(selected) || saving}
                  required
                  maxLength={64}
                  pattern="[a-z0-9](?:(?:[a-z0-9._]|-){0,62}[a-z0-9])?"
                  onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))}
                />
              </label>
              <label>
                <span>Alias</span>
                <input
                  value={draft.alias}
                  disabled={saving}
                  required
                  maxLength={120}
                  onChange={(event) => setDraft((current) => ({ ...current, alias: event.target.value }))}
                />
              </label>
              <label className="jira-provider-wide-field">
                <span>Jira CLI 配置</span>
                <input
                  value={draft.configPath}
                  disabled={saving}
                  required
                  maxLength={4096}
                  placeholder="/Users/name/.config/.jira/.config.yml"
                  onChange={(event) => setDraft((current) => ({ ...current, configPath: event.target.value }))}
                />
                {!selected && discoveryComplete && (
                  <small className="jira-provider-discovery">
                    {detectedConfig
                      ? "已自动读取本地 Jira CLI 配置"
                      : "未发现未配置的本地 Jira CLI 配置，请手动填写"}
                  </small>
                )}
              </label>
              <label className="jira-provider-wide-field">
                <span>JQL</span>
                <textarea
                  value={draft.jql}
                  disabled={saving}
                  required
                  maxLength={10_000}
                  rows={3}
                  onChange={(event) => setDraft((current) => ({ ...current, jql: event.target.value }))}
                />
              </label>
              <ToggleRow
                label="启用 provider"
                value={draft.enabled}
                disabled={saving}
                onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
              <ToggleRow
                label="预览同步"
                value={draft.preview}
                disabled={saving}
                onChange={(preview) => setDraft((current) => ({ ...current, preview }))}
              />
              <ToggleRow
                label="自动完成 Jira"
                value={draft.autoComplete}
                disabled={saving}
                onChange={(autoComplete) => setDraft((current) => ({ ...current, autoComplete }))}
              />
              <label>
                <span>完成状态</span>
                <input
                  value={draft.completionStatus ?? ""}
                  disabled={!draft.autoComplete || saving}
                  required={draft.autoComplete}
                  maxLength={120}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    completionStatus: event.target.value || null,
                  }))}
                />
              </label>
              {selected && (
                <section className="jira-scheduled-task jira-provider-wide-field">
                  <div className="jira-scheduled-task-heading">
                    <span>Scheduled Task</span>
                    <strong data-state={automationState ?? "unknown"}>{automationLabel}</strong>
                  </div>
                  <small>每天 09:00 Asia/Shanghai 运行，支持手动立即同步。</small>
                  {automationNotice && (
                    <p className="jira-provider-notice" role="status">{automationNotice}</p>
                  )}
                  <div className="jira-scheduled-task-actions">
                    {(automationState === "drifted" || (
                      automationState === "missing" && selected.enabled
                    )) && (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={automationPending || !automationAvailable}
                        onClick={() => void requestAutomation(selected, "restore")}
                      >
                        恢复标准任务
                      </button>
                    )}
                    <button
                      className="button secondary"
                      type="button"
                      disabled={
                        automationPending
                        || !automationAvailable
                        || !selected.enabled
                        || automationState !== "normal"
                      }
                      onClick={() => void requestAutomation(selected, "run-now")}
                    >
                      {automationPending ? "处理中…" : "立即同步"}
                    </button>
                  </div>
                </section>
              )}
            </div>

            {error && <p className="jira-provider-error" role="alert">{error}</p>}

            <footer>
              {selected ? (
                <button
                  className="jira-provider-delete"
                  type="button"
                  aria-label={`删除 ${selected.alias}`}
                  disabled={saving || automationPending}
                  onClick={() => void removeProvider()}
                >
                  <LinearIcon name="trash" />
                  <span>删除</span>
                </button>
              ) : <span />}
              <div>
                <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
                  取消
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!canSave || saving || automationPending}
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </footer>
          </form>
        </div>
      </section>
    </div>
  );
}
