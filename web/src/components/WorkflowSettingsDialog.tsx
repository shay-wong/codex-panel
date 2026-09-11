import { useEffect, useState } from "react";
import {
  Box, Button, Checkbox, Flex, Heading, IconButton, Popover,
  ScrollArea, Separator, Text, TextField, Theme,
} from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";

import { getAiChatCatalog, getWorkflowSettings, saveWorkflowSettings } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { AiChatSkill, WorkflowSettings } from "../types";
import { LinearIcon } from "./LinearIcon";

export function WorkflowSettingsDialog({ projectId, onClose }: {
  projectId: string;
  onClose: () => void;
}) {
  const { text } = useTaskboardI18n();
  const [appearance, setAppearance] = useState<"light" | "dark">(() => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [settings, setSettings] = useState<WorkflowSettings | null>(null);
  const [skills, setSkills] = useState<AiChatSkill[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openStage, setOpenStage] = useState<keyof WorkflowSettings | null>(null);
  const [search, setSearch] = useState("");
  const stages: Array<{ id: keyof WorkflowSettings; label: string; defaultLabel: string }> = [
    { id: "planning", label: text("AI 规划", "AI planning"), defaultLabel: text("Codex Plan 模式", "Codex Plan mode") },
    { id: "execution", label: text("任务执行", "Task execution"), defaultLabel: text("Codex 默认执行", "Codex default execution") },
    { id: "review", label: text("代码审核", "Code review"), defaultLabel: "Codex Review" },
    { id: "handoff", label: text("任务交接", "Task handoff"), defaultLabel: text("Panel 内置交接", "Panel built-in handoff") },
  ];
  const needle = search.trim().toLocaleLowerCase();
  const visibleSkills = skills.filter((skill) => `${skill.label} ${skill.id}`.toLocaleLowerCase().includes(needle));

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const next = media.matches ? "dark" : "light";
      setAppearance(next);
      document.documentElement.dataset.theme = next;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void getWorkflowSettings(controller.signal).then(setSettings).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    void getAiChatCatalog(projectId, controller.signal).then((catalog) => {
      if (!controller.signal.aborted) setSkills(catalog.skills.filter((skill) => !["manage-panel", "handoff-panel"].includes(skill.id)));
    }).catch(() => {
      if (!controller.signal.aborted) setCatalogError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setCatalogLoading(false);
    });
    return () => controller.abort();
  }, [projectId]);

  function updateStage(stage: keyof WorkflowSettings, ids: string[]) {
    setSettings((current) => current && { ...current, [stage]: ids });
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      await saveWorkflowSettings(settings);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Theme appearance={appearance} accentColor="gray" grayColor="gray" radius="medium" scaling="95%">
      <form
        aria-labelledby="workflow-settings-title"
        style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
        onSubmit={(event) => { event.preventDefault(); void save(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "search") event.preventDefault();
          if (event.key === "Escape" && !openStage && !saving) onClose();
        }}
      >
        <Box px="5" pt="4" pb="3">
          <Flex align="center" justify="between" gap="3" mb="2">
            <Heading as="h2" size="3" id="workflow-settings-title">{text("工作流设置", "Workflow settings")}</Heading>
            <IconButton variant="ghost" size="1" type="button" disabled={saving} onClick={onClose} aria-label={text("关闭", "Close")}>
              <LinearIcon name="close" />
            </IconButton>
          </Flex>
          <Text as="p" size="1" color="gray">{text("所有项目共用，仅对新发起的操作生效。", "Shared by all projects. Applies to new actions only.")}</Text>
          <Text as="p" size="1" color="gray" mt="1">{text("未选择 Skill 时使用默认流程；多个 Skill 按顺序执行。", "Leave a stage empty to use its default. Selected Skills run in order.")}</Text>
        </Box>
        <ScrollArea type="auto" scrollbars="vertical" style={{ flex: 1, minHeight: 0 }}>
          <Box px="5" pb="3">
            {!settings && !error && <Text as="p" size="2" role="status">{text("正在加载设置…", "Loading settings…")}</Text>}
            {settings && stages.map((stage) => {
              const selected = settings[stage.id];
              return (
                <section key={stage.id} aria-labelledby={`workflow-stage-${stage.id}`}>
                  <Separator size="4" />
                  <Box py="3">
                    <Flex align="center" justify="between" gap="3">
                      <Box>
                        <Heading as="h3" size="2" weight="medium" id={`workflow-stage-${stage.id}`}>{stage.label}</Heading>
                        <Text as="p" size="1" color="gray" mt="1">{selected.length ? text("自定义 Skill", "Custom Skills") : stage.defaultLabel}</Text>
                      </Box>
                      <Popover.Root open={openStage === stage.id} onOpenChange={(open) => { setOpenStage(open ? stage.id : null); setSearch(""); }}>
                        <Popover.Trigger>
                          <Button type="button" variant="soft" size="1" disabled={saving || catalogLoading || catalogError} aria-label={text(`选择${stage.label} Skill`, `Choose ${stage.label} Skills`)}>
                            {text("选择 Skill", "Choose Skills")}<LinearIcon name="chevronDown" />
                          </Button>
                        </Popover.Trigger>
                        <Popover.Content size="2" align="end" width="310px" maxWidth="calc(100vw - 24px)" aria-label={text(`${stage.label} Skill`, `${stage.label} Skills`)}>
                          <TextField.Root type="search" size="2" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={text("搜索名称…", "Search by name…")} aria-label={text("搜索 Skill", "Search Skills")}>
                            <TextField.Slot><LinearIcon name="search" /></TextField.Slot>
                          </TextField.Root>
                          <ScrollArea type="auto" scrollbars="vertical" style={{ height: 180 }} mt="2">
                            {visibleSkills.map((skill) => (
                              <Text as="label" size="2" key={skill.id}>
                                <Flex align="center" gap="2" py="2" pr="2">
                                  <Checkbox size="1" checked={selected.includes(skill.id)} disabled={saving || (!selected.includes(skill.id) && selected.length >= 20)} onCheckedChange={(checked) => updateStage(stage.id, checked ? [...selected, skill.id] : selected.filter((id) => id !== skill.id))} />
                                  <Text truncate title={skill.id}>{skill.label === skill.id ? skill.id : `${skill.label} · ${skill.id}`}</Text>
                                </Flex>
                              </Text>
                            ))}
                            {!visibleSkills.length && <Text as="p" size="1" color="gray" mt="2">{text("没有匹配的 Skill", "No matching Skills")}</Text>}
                          </ScrollArea>
                          <Separator size="4" my="2" />
                          <Button variant="ghost" size="1" type="button" disabled={saving} onClick={() => { updateStage(stage.id, []); setOpenStage(null); }}>{text("恢复默认", "Use default")}: {stage.defaultLabel}</Button>
                        </Popover.Content>
                      </Popover.Root>
                    </Flex>
                    {selected.length > 0 && (
                      <Box mt="2">
                        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                          {selected.map((id, index) => {
                            const skill = skills.find((candidate) => candidate.id === id);
                            return (
                              <li key={id}>
                                <Flex align="center" gap="2" py="1">
                                  <Text size="1" color="gray" style={{ width: 16, flexShrink: 0 }}>{index + 1}</Text>
                                  <Box style={{ flex: 1, minWidth: 0 }}>
                                    <Text as="div" size="1" truncate title={id}>{skill?.label ?? id}</Text>
                                    {!skill && !catalogLoading && <Text as="div" size="1" color="gray">{catalogError ? text("可用性未确认", "Availability unknown") : text("当前目录未找到", "Not found in current catalog")}</Text>}
                                  </Box>
                                  <IconButton type="button" variant="ghost" size="1" disabled={saving || index === 0} aria-label={text(`上移 ${id}`, `Move ${id} up`)} onClick={() => {
                                    const next = [...selected];
                                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                    updateStage(stage.id, next);
                                  }}><LinearIcon name="chevronDown" style={{ transform: "rotate(180deg)" }} /></IconButton>
                                  <IconButton type="button" variant="ghost" size="1" disabled={saving || index === selected.length - 1} aria-label={text(`下移 ${id}`, `Move ${id} down`)} onClick={() => {
                                    const next = [...selected];
                                    [next[index], next[index + 1]] = [next[index + 1], next[index]];
                                    updateStage(stage.id, next);
                                  }}><LinearIcon name="chevronDown" /></IconButton>
                                  <IconButton type="button" variant="ghost" size="1" disabled={saving} aria-label={text(`移除 ${id}`, `Remove ${id}`)} onClick={() => updateStage(stage.id, selected.filter((value) => value !== id))}><LinearIcon name="close" /></IconButton>
                                </Flex>
                              </li>
                            );
                          })}
                        </ol>
                      </Box>
                    )}
                    {selected.length >= 20 && <Text as="p" size="1" color="gray" mt="2" role="status">{text("每个阶段最多选择 20 个 Skill。", "Each stage supports up to 20 Skills.")}</Text>}
                  </Box>
                </section>
              );
            })}
            {catalogLoading && <Text as="p" size="1" color="gray" role="status">{text("正在读取可用 Skill…", "Loading available Skills…")}</Text>}
            {catalogError && <Text as="p" size="1" color="gray" role="status">{text("暂时无法读取 Skill 列表。已有选择会保留，仍可移除 Skill 并保存默认流程。", "The Skill catalog is unavailable. Existing selections are preserved; you can still remove Skills and save defaults.")}</Text>}
            {error && <Text as="p" size="1" color="red" role="alert">{error}</Text>}
          </Box>
        </ScrollArea>
        <Box px="5" pb="4" pt="2">
          <Separator size="4" mb="3" />
          <Flex justify="end" gap="2">
            <Button type="button" variant="soft" size="2" disabled={saving} onClick={onClose}>{text("取消", "Cancel")}</Button>
            <Button type="submit" size="2" highContrast loading={saving} disabled={!settings || saving}>{text("保存", "Save")}</Button>
          </Flex>
        </Box>
      </form>
    </Theme>
  );
}
