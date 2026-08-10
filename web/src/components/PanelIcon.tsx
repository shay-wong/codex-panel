import type { ImgHTMLAttributes } from "react";
import aiLauncher from "../assets/panel/ai-launcher.svg";
import automationPause from "../assets/panel/automation-pause.svg";
import automationPlay from "../assets/panel/automation-play.svg";
import breadcrumb from "../assets/panel/breadcrumb.svg";
import calendar from "../assets/panel/calendar.svg";
import columnAddBlocked from "../assets/panel/column-add-blocked.svg";
import columnAddProgress from "../assets/panel/column-add-progress.svg";
import columnAddReview from "../assets/panel/column-add-review.svg";
import columnAddTodo from "../assets/panel/column-add-todo.svg";
import columnAdd from "../assets/panel/column-add.svg";
import columnStatusBlocked from "../assets/panel/column-status-blocked.svg";
import columnStatusProgress from "../assets/panel/column-status-progress.svg";
import columnStatusReview from "../assets/panel/column-status-review.svg";
import columnStatusTodo from "../assets/panel/column-status-todo.svg";
import conversation from "../assets/panel/conversation.svg";
import create from "../assets/panel/create.svg";
import dropdown from "../assets/panel/dropdown.svg";
import filter from "../assets/panel/filter.svg";
import home from "../assets/panel/home.svg";
import panel from "../assets/panel/panel.svg";
import projectFolder from "../assets/panel/project-folder.svg";
import relationBlockedBy from "../assets/panel/relation-blocked-by.svg";
import relationBlocks from "../assets/panel/relation-blocks.svg";
import search from "../assets/panel/search.svg";
import sidebarAdd from "../assets/panel/sidebar-add.svg";
import statusBlocked from "../assets/panel/status-blocked.svg";
import statusProgress from "../assets/panel/status-progress.svg";
import statusReview from "../assets/panel/status-review.svg";
import statusTodo from "../assets/panel/status-todo.svg";

const PANEL_ICONS = {
  aiLauncher,
  automationPause,
  automationPlay,
  breadcrumb,
  calendar,
  columnAdd,
  columnAddBlocked,
  columnAddProgress,
  columnAddReview,
  columnAddTodo,
  columnStatusBlocked,
  columnStatusProgress,
  columnStatusReview,
  columnStatusTodo,
  conversation,
  create,
  dropdown,
  filter,
  home,
  panel,
  projectFolder,
  relationBlockedBy,
  relationBlocks,
  search,
  sidebarAdd,
  statusBlocked,
  statusProgress,
  statusReview,
  statusTodo,
} as const;

export type PanelIconName = keyof typeof PANEL_ICONS;

const MONOCHROME_ICONS = new Set<PanelIconName>([
  "aiLauncher",
  "automationPlay",
  "breadcrumb",
  "calendar",
  "columnAdd",
  "conversation",
  "create",
  "dropdown",
  "filter",
  "home",
  "panel",
  "projectFolder",
  "search",
  "sidebarAdd",
  "statusBlocked",
  "statusProgress",
  "statusReview",
  "statusTodo",
]);

export function panelIconSource(name: PanelIconName) {
  return PANEL_ICONS[name];
}

interface PanelIconProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> {
  name: PanelIconName;
}

export function PanelIcon({ name, className, ...props }: PanelIconProps) {
  const classes = [
    "panel-icon",
    MONOCHROME_ICONS.has(name) ? "panel-icon-monochrome" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <img
      {...props}
      className={classes}
      src={PANEL_ICONS[name]}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
