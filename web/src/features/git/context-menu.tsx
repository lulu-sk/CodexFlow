// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const CONTEXT_MENU_SAFE_GAP = 6;

export type GitContextMenuState = {
  x: number;
  y: number;
};

type ContextMenuProps = {
  menu: GitContextMenuState | null;
  onClose(): void;
  children: React.ReactNode;
  actionGroupId?: string;
};

/**
 * 统一右键菜单定位与 Portal 渲染，避免各 Git 子模块重复处理视口避让。
 */
export function ContextMenu(props: ContextMenuProps): JSX.Element | null {
  const { menu, onClose, children, actionGroupId } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!menu) return;
    const panel = panelRef.current;
    if (!panel) {
      setPosition({ left: menu.x, top: menu.y });
      return;
    }
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(CONTEXT_MENU_SAFE_GAP, window.innerWidth - rect.width - CONTEXT_MENU_SAFE_GAP);
    const maxTop = Math.max(CONTEXT_MENU_SAFE_GAP, window.innerHeight - rect.height - CONTEXT_MENU_SAFE_GAP);
    setPosition({
      left: Math.max(CONTEXT_MENU_SAFE_GAP, Math.min(menu.x, maxLeft)),
      top: Math.max(CONTEXT_MENU_SAFE_GAP, Math.min(menu.y, maxTop)),
    });
  }, [children, menu]);

  if (!menu) return null;

  const body = (
    <>
      <div className="fixed inset-0 z-[1200]" onMouseDown={onClose}></div>
      <div
        ref={panelRef}
        className="cf-git-menu-panel fixed z-[1201] min-w-[210px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-1.5 text-[var(--cf-text-primary)]"
        style={{ left: position.left, top: position.top }}
        data-action-group={actionGroupId}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </div>
    </>
  );

  if (typeof document === "undefined") return body;
  return createPortal(body, document.body);
}

export type ContextMenuItemProps = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  dimmed?: boolean;
  tone?: "default" | "danger";
  title?: string;
  onClick?(): void;
};

/**
 * 统一右键菜单项排版，确保菜单文案与快捷键列对齐。
 */
export function ContextMenuItem(props: ContextMenuItemProps): JSX.Element {
  const { label, shortcut, disabled, checked, dimmed, tone = "default", title, onClick } = props;
  return (
    <button
      className="cf-git-menu-item flex w-full items-center justify-between gap-3 rounded-apple-sm px-2.5 py-1.5 text-left text-[11px] disabled:opacity-40"
      disabled={disabled}
      title={disabled ? title : undefined}
      onClick={onClick}
    >
      <span
        className={cn(
          dimmed ? "opacity-50" : "",
          tone === "danger" ? "text-[var(--cf-red)]" : "",
        )}
      >
        {checked ? `✓ ${label}` : label}
      </span>
      <span className="min-w-[84px] shrink-0 text-right text-[11px] text-[var(--cf-text-secondary)]">{shortcut || ""}</span>
    </button>
  );
}

type ContextMenuSubmenuProps = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
};

/**
 * 统一右键菜单子菜单渲染，支持悬停展开并自动避让视口边缘。
 */
export function ContextMenuSubmenu(props: ContextMenuSubmenuProps): JSX.Element {
  const { label, shortcut, disabled, title, children } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<boolean>(false);
  const [openToLeft, setOpenToLeft] = useState<boolean>(false);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useLayoutEffect(() => {
    if (!open) {
      if (openToLeft) setOpenToLeft(false);
      return;
    }
    const wrapper = wrapperRef.current;
    const panel = panelRef.current;
    if (!wrapper || !panel) return;
    const panelRect = panel.getBoundingClientRect();
    const shouldOpenLeft = panelRect.right > window.innerWidth - CONTEXT_MENU_SAFE_GAP;
    if (shouldOpenLeft !== openToLeft) setOpenToLeft(shouldOpenLeft);
  }, [open, openToLeft]);

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={() => {
        if (!disabled) setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
    >
      <button
        className="cf-git-menu-item flex w-full items-center justify-between gap-3 rounded-apple-sm px-2.5 py-1.5 text-left text-[11px] disabled:opacity-40"
        disabled={disabled}
        title={disabled ? title : undefined}
      >
        <span>{label}</span>
        <span className="flex items-center gap-2 text-[11px] text-[var(--cf-text-secondary)]">
          {shortcut || ""}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="absolute top-0 z-[1202] min-w-[210px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-1.5 shadow-apple-lg"
          style={{
            left: openToLeft ? "auto" : "calc(100% + 4px)",
            right: openToLeft ? "calc(100% + 4px)" : "auto",
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 按分节渲染右键菜单内容，自动跳过空分组并插入分隔线。
 */
export function renderContextMenuSections(
  sections: Array<Array<React.ReactNode | null | false>>,
): React.ReactNode {
  const visibleSections = sections
    .map((section) => section.filter(Boolean) as React.ReactNode[])
    .filter((section) => section.length > 0);
  if (visibleSections.length === 0) return null;
  return visibleSections.map((section, sectionIndex) => (
    <React.Fragment key={`menu-section-${sectionIndex}`}>
      {sectionIndex > 0 ? <div className="my-1 h-px bg-[var(--cf-border)]"></div> : null}
      {section.map((node, nodeIndex) => (
        <React.Fragment key={`menu-section-${sectionIndex}-item-${nodeIndex}`}>{node}</React.Fragment>
      ))}
    </React.Fragment>
  ));
}
