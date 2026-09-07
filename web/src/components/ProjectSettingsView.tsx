import type { Project } from "../types";
import { useTaskboardI18n } from "../i18n";

interface ProjectSettingsViewProps {
  project: Project;
  onEditIssueKey: () => void;
}

export function ProjectSettingsView({ project, onEditIssueKey }: ProjectSettingsViewProps) {
  const { text } = useTaskboardI18n();

  return (
    <div className="project-settings-view">
      <section>
        <div>
          <h2>{text("任务编号", "Issue IDs")}</h2>
          <p>{text(
            "项目 Key 用作该项目任务编号的前缀。",
            "The Project Key is used as the prefix for issue IDs in this project.",
          )}</p>
        </div>
        <div className="project-settings-control">
          <span>{text("项目 Key", "Project Key")}</span>
          <strong>{project.issueKey}</strong>
          {project.source === "local" && (
            <button className="button secondary" type="button" onClick={onEditIssueKey}>
              {text("修改", "Change")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
