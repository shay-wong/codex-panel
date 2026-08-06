import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { LinearIcon } from "./LinearIcon";

export interface DetailSelectOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  group?: string;
}

interface DetailPropertySelectProps<T extends string> {
  value: T;
  options: Array<DetailSelectOption<T>>;
  ariaLabel: string;
  disabled?: boolean;
  title?: string;
  onChange: (value: T) => void;
}

export function DetailPropertySelect<T extends string>({
  value,
  options,
  ariaLabel,
  disabled = false,
  title,
  onChange,
}: DetailPropertySelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"down" | "up">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (!open) return;

    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeFromViewportChange() {
      setOpen(false);
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("blur", closeFromViewportChange);
    window.addEventListener("resize", closeFromViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("blur", closeFromViewportChange);
      window.removeEventListener("resize", closeFromViewportChange);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open || !menuRef.current || !triggerRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom - 8;
    const spaceAbove = triggerRect.top - 8;
    setPlacement(menuRect.height > spaceBelow && spaceAbove > spaceBelow ? "up" : "down");
    requestAnimationFrame(() => {
      const selectedOption = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]',
      );
      const firstOption = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="option"]',
      );
      (selectedOption ?? firstOption)?.focus();
    });
  }, [open, options.length, value]);

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function moveOptionFocus(event: KeyboardEvent<HTMLDivElement>, direction: 1 | -1) {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    )];
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveOptionFocus(event, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveOptionFocus(event, -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      )];
      (event.key === "Home" ? buttons[0] : buttons.at(-1))?.focus();
    } else if (event.key === "Tab") {
      closeMenu();
    }
  }

  return (
    <div ref={rootRef} className={`detail-select is-${placement}${open ? " is-open" : ""}`}>
      <button
        ref={triggerRef}
        className="detail-select-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <LinearIcon name="chevronDown" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="detail-select-menu"
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option, index) => (
            <Fragment key={option.value}>
              {option.group && option.group !== options[index - 1]?.group && (
                <div className="detail-select-group" role="presentation">{option.group}</div>
              )}
              <button
                className="detail-select-option"
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  if (option.value !== value) onChange(option.value);
                  closeMenu(true);
                }}
              >
                <span className="detail-select-option-icon" aria-hidden="true">
                  {option.icon}
                </span>
                <strong className="detail-select-option-label">{option.label}</strong>
                {option.value === value && (
                  <span className="detail-select-option-check" aria-hidden="true">
                    <LinearIcon name="check" />
                  </span>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
