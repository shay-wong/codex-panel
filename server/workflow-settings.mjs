export const WORKFLOW_STAGES = ["planning", "execution", "review", "handoff"];

export function defaultWorkflowSettings() {
  return Object.fromEntries(WORKFLOW_STAGES.map((stage) => [stage, []]));
}

// Resolve IDs in the target workspace; never persist a machine-specific Skill path.
export async function resolveWorkflow(database, aiChat, projectId, stage, catalog) {
  const ids = database.getWorkflowSettings()[stage];
  if (ids.length === 0) return { skills: [], missing: [], mode: "default" };
  const available = catalog ?? await aiChat.getCatalog(projectId);
  const byId = new Map(available.skills.map((skill) => [skill.id, skill]));
  const missing = ids.filter((id) => !byId.has(id));
  return {
    // An ordered workflow is selected as a whole; don't execute an incomplete chain.
    skills: missing.length ? [] : ids.map((id) => {
      const skill = byId.get(id);
      return { id: skill.id, label: skill.label, path: skill.path };
    }),
    missing,
    mode: missing.length ? "default" : "custom",
  };
}

export function workflowNotice(workflow) {
  return workflow.missing.length
    ? `已配置的 Skill 不可用：${workflow.missing.join("、")}。本次使用默认流程。`
    : "";
}
