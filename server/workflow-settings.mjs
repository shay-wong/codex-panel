import promptDefaults from "../shared/workflow-prompts.json" with { type: "json" };

export const WORKFLOW_STAGES = ["planning", "execution", "review", "handoff"];

export function defaultWorkflowSettings() {
  return Object.fromEntries(WORKFLOW_STAGES.map((stage) => [stage, []]));
}

// Resolve IDs in the target workspace; never persist a machine-specific Skill path.
export async function resolveWorkflow(database, aiChat, projectId, stage, catalog) {
  const settings = database.getWorkflowSettings();
  const ids = settings[stage];
  const definition = promptDefaults[stage];
  const template = settings.prompts?.[stage]?.trim() || definition.prompt;
  const available = ids.length ? catalog ?? await aiChat.getCatalog(projectId) : { skills: [] };
  const byId = new Map(available.skills.map((skill) => [skill.id, skill]));
  const missing = ids.filter((id) => !byId.has(id));
  // An ordered workflow is selected as a whole; don't execute an incomplete chain.
  const skills = missing.length ? [] : ids.map((id) => {
    const skill = byId.get(id);
    return { id: skill.id, label: skill.label, path: skill.path };
  });
  const method = skills.length
    ? `按顺序使用已选择的 Skill：${skills.map((skill) => skill.id).join(" → ")}。`
    : definition.defaultMethod;
  return {
    appliesWhen: definition.appliesWhen,
    skills,
    missing,
    mode: skills.length ? "custom" : "default",
    prompt: template.replaceAll("{{skill_instructions}}", () => method),
    rules: definition.rules,
  };
}

export function workflowNotice(workflow) {
  return workflow.missing.length
    ? `已配置的 Skill 不可用：${workflow.missing.join("、")}。本次使用默认流程。`
    : "";
}
