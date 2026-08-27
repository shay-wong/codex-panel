import type { MouseEvent, ReactNode } from "react";

import { LinearIcon } from "./LinearIcon";
import { TaskboardIcon } from "./TaskboardIcon";

export interface ProjectSelectionItem {
  id: string;
  name: string;
  dividerBefore?: boolean;
  dividerAfter?: boolean;
  searchable?: boolean;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}

interface ProjectSelectionMenuProps {
  ariaLabel: string;
  items: ProjectSelectionItem[];
  selectedIds: ReadonlySet<string>;
  searchValue: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearSearchLabel: string;
  emptyMessage: string;
  onSearchChange: (value: string) => void;
  onSelect: (item: ProjectSelectionItem) => void;
  actions?: ReactNode;
  className?: string;
  disabled?: boolean;
  heading?: string;
  multiple?: boolean;
}

export function ProjectSelectionMenu({
  ariaLabel,
  items,
  selectedIds,
  searchValue,
  searchLabel,
  searchPlaceholder,
  clearSearchLabel,
  emptyMessage,
  onSearchChange,
  onSelect,
  actions,
  className = "",
  disabled = false,
  heading,
  multiple = false,
}: ProjectSelectionMenuProps) {
  const needle = searchValue.trim().toLocaleLowerCase();
  const visibleItems = needle
    ? items.filter((item) => (
        item.searchable !== false && item.name.toLocaleLowerCase().includes(needle)
      ))
    : items;

  return (
    <div
      className={`project-selection-menu${className ? ` ${className}` : ""}`}
      role="menu"
      aria-label={ariaLabel}
    >
      {heading && <span>{heading}</span>}
      <div className="project-menu-search">
        <TaskboardIcon name="search" />
        <input
          autoFocus
          type="search"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchLabel}
        />
        {searchValue && (
          <button
            className="search-clear"
            type="button"
            aria-label={clearSearchLabel}
            onClick={() => onSearchChange("")}
          >
            <LinearIcon name="close" />
          </button>
        )}
      </div>
      <div className="project-menu-list">
        {visibleItems.map((item, index) => {
          const checked = selectedIds.has(item.id);
          return (
            <div key={item.id}>
              {item.dividerBefore && index > 0 && (
                <div className="project-menu-divider" role="separator" />
              )}
              <button
                type="button"
                role={multiple ? "menuitemcheckbox" : "menuitemradio"}
                aria-checked={checked}
                disabled={disabled}
                onContextMenu={item.onContextMenu}
                onClick={() => onSelect(item)}
              >
                <TaskboardIcon className="project-avatar" name="projectFolder" />
                <span>{item.name}</span>
                {checked && (
                  <span className="project-menu-check" aria-hidden="true">
                    <LinearIcon name="check" />
                  </span>
                )}
              </button>
              {item.dividerAfter && index < visibleItems.length - 1 && (
                <div className="project-menu-divider" role="separator" />
              )}
            </div>
          );
        })}
        {needle && visibleItems.length === 0 && (
          <div className="project-menu-empty">{emptyMessage}</div>
        )}
      </div>
      {actions && <div className="project-menu-actions">{actions}</div>}
    </div>
  );
}
