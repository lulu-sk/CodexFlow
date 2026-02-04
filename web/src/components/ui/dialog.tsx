// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

type Ctx = { open: boolean; setOpen: (v: boolean) => void };
const DialogContext = React.createContext<Ctx | null>(null);

const DIALOG_CONTENT_SELECTOR = '[data-cf-dialog-content="true"]';
let dialogGlobalKeydownInstalled = false;

/**
 * 中文说明：判断 Enter 自动确认是否需要跳过当前事件目标（仅在事件目标位于弹窗内时）。
 * - textarea / 可编辑区域：Enter 通常用于换行
 * - button：让浏览器默认行为接管，避免二次触发
 */
function shouldSkipEnterAutoConfirm(target: EventTarget | null, dialogRoot: HTMLElement): boolean {
  try {
    const el = target as any;
    if (!el) return false;
    // 仅当焦点/事件目标在弹窗内容内时才跳过；否则应由弹窗接管 Enter，避免背景元素吞掉确认键。
    try {
      if (el instanceof Node && !dialogRoot.contains(el)) return false;
    } catch {}
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLButtonElement) return true;
    if (typeof el.isContentEditable === "boolean" && el.isContentEditable) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 中文说明：判断按钮是否可被“Enter 自动确认”安全点击。
 */
function isClickableButton(btn: HTMLButtonElement | null): btn is HTMLButtonElement {
  if (!btn) return false;
  try {
    if (btn.disabled) return false;
    if (btn.getAttribute("aria-disabled") === "true") return false;
    // 尽量避免点到隐藏按钮
    const style = window.getComputedStyle(btn);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 中文说明：在弹窗内容区域内寻找“主按钮”。
 * - 优先：`data-cf-dialog-primary="true"`
 * - 兜底：最后一个可点击的 button（符合大多数“取消在左/确认在右”的布局习惯）
 */
function findDialogPrimaryButton(root: HTMLElement): HTMLButtonElement | null {
  const primary = root.querySelector<HTMLButtonElement>('button[data-cf-dialog-primary="true"]');
  if (isClickableButton(primary)) return primary;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter(isClickableButton);
  return buttons.length > 0 ? buttons[buttons.length - 1] : null;
}

/**
 * 中文说明：在弹窗内容区域内寻找“取消按钮”。
 * - 优先：`data-cf-dialog-cancel="true"`
 * - 兜底：根据按钮文本识别（如“取消/关闭/返回”或“Cancel/Close/Back”），避免误点确认按钮
 */
function findDialogCancelButton(root: HTMLElement): HTMLButtonElement | null {
  const cancel = root.querySelector<HTMLButtonElement>('button[data-cf-dialog-cancel="true"]');
  if (isClickableButton(cancel)) return cancel;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter(isClickableButton);
  const normalize = (s: string) => String(s || "").replace(/\s+/g, " ").trim();
  const matches = (label: string) => {
    const text = normalize(label);
    const lower = text.toLowerCase();
    const hasHintSuffix = (raw: string, base: string) => {
      const rest = raw.slice(base.length).trim();
      return rest.length > 0 && (/^[\(\（]/.test(rest));
    };
    const cnBases = ["取消", "关闭", "返回"];
    for (const b of cnBases) {
      if (text === b) return true;
      if (text.startsWith(b) && hasHintSuffix(text, b)) return true;
    }
    const enBases = ["cancel", "close", "back"];
    for (const b of enBases) {
      if (lower === b) return true;
      if (lower.startsWith(b) && hasHintSuffix(lower, b)) return true;
    }
    return false;
  };
  for (const btn of buttons) {
    const label = normalize(btn.textContent || "");
    if (matches(label)) return btn;
  }
  return null;
}

/**
 * 中文说明：全局 Dialog 键盘处理。
 * - 仅在存在打开的 DialogContent 时生效
 * - Enter：触发“主按钮”（确认）
 * - Escape：触发“取消按钮”（取消）；若未找到取消按钮则关闭弹窗
 */
function handleGlobalDialogKeydown(event: KeyboardEvent) {
  if (!event || event.defaultPrevented) return;

  try {
    const list = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_CONTENT_SELECTOR));
    if (list.length === 0) return;
    const topmost = list[list.length - 1];
    if ((event as any).isComposing) return;

    if (event.key === "Enter") {
      // 仅处理“纯 Enter”（不含 Ctrl/Alt/Meta/Shift），避免干扰既有快捷键
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.shiftKey) return;
      if (shouldSkipEnterAutoConfirm(event.target, topmost)) return;
      const btn = findDialogPrimaryButton(topmost);
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      btn.click();
      return;
    }

    if (event.key === "Escape") {
      const cancel = findDialogCancelButton(topmost);
      if (cancel) {
        event.preventDefault();
        event.stopPropagation();
        cancel.click();
        return;
      }
      // 兜底：关闭弹窗（等同于点击遮罩）
      const overlay = topmost.parentElement?.querySelector<HTMLElement>('[data-cf-dialog-overlay="true"]');
      if (overlay) {
        event.preventDefault();
        event.stopPropagation();
        overlay.click();
      }
    }
  } catch {}
}

/**
 * 中文说明：确保全局 Dialog 键盘处理只注册一次。
 */
function ensureDialogGlobalKeydownInstalled() {
  if (dialogGlobalKeydownInstalled) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  dialogGlobalKeydownInstalled = true;
  // 使用捕获阶段，避免被 xterm 等组件在冒泡阶段 stopPropagation 导致弹窗快捷键失效。
  window.addEventListener("keydown", handleGlobalDialogKeydown, true);
}

export function Dialog({ open: openProp, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children: React.ReactNode }) {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const open = openProp ?? uncontrolled;
  const setOpen = (v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    else setUncontrolled(v);
  };
  return <DialogContext.Provider value={{ open, setOpen }}>{children}</DialogContext.Provider>;
}

export function DialogTrigger({ asChild, children }: { asChild?: boolean; children: React.ReactElement }) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return children;
  const child = React.cloneElement(children, {
    onClick: (e: any) => {
      children.props.onClick?.(e);
      ctx.setOpen(true);
    }
  });
  return child;
}

export function DialogContent({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const ctx = React.useContext(DialogContext);
  const [isVisible, setIsVisible] = React.useState(false);

  React.useEffect(() => {
    ensureDialogGlobalKeydownInstalled();
  }, []);

  React.useEffect(() => {
    let raf1: number | null = null;
    let raf2: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    if (ctx?.open) {
      const hasRAF = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
      if (hasRAF) {
        // 延迟触发动画，确保初始状态先渲染
        raf1 = window.requestAnimationFrame(() => {
          raf2 = window.requestAnimationFrame(() => {
            setIsVisible(true);
          });
        });
      } else {
        // 在无 requestAnimationFrame 的环境（如单元测试）兼容处理
        fallbackTimer = setTimeout(() => {
          setIsVisible(true);
        }, 0);
      }
    } else {
      setIsVisible(false);
    }

    return () => {
      if (raf1 !== null) cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    };
  }, [ctx?.open]);

  if (!ctx || !ctx.open) return null;
  
  return createPortal(
    <div className={cn(
      'fixed inset-0 z-50 flex items-center justify-center transition-all duration-apple-slow ease-apple',
      isVisible ? 'opacity-100' : 'opacity-0'
    )} data-cf-dialog-root="true">
      <div 
        className={cn(
          'absolute inset-0 bg-black/40 backdrop-blur-apple transition-all duration-apple-slow ease-apple',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
        data-cf-dialog-overlay="true"
        onClick={() => ctx.setOpen(false)} 
      />
      <div 
        className={cn(
          'relative z-10 w-[520px] rounded-apple-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple-lg p-6 shadow-apple-xl text-[var(--cf-text-primary)] transition-all duration-apple-slow ease-apple dark:shadow-apple-dark-xl',
          isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
          className
        )}
        data-cf-dialog-content="true"
        {...rest}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function DialogHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4', props.className)} {...props} />;
}
export function DialogTitle(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-xl font-apple-semibold text-[var(--cf-text-primary)] mb-2', props.className)} {...props} />;
}
export function DialogDescription(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm text-[var(--cf-text-secondary)] leading-relaxed', props.className)} {...props} />;
}
