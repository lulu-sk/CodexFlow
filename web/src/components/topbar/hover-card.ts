// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useCallback, useEffect, useRef, useState } from "react";

export type HoverHandlers = {
  open: boolean;
  onEnter: () => void;
  onLeave: () => void;
};

export type HoverCardOptions = {
  /** 鼠标悬停后延迟打开（ms），用于避免“划过即弹”的干扰。 */
  openDelayMs?: number;
  /** 鼠标离开后延迟关闭（ms），用于避免边缘抖动导致闪烁。 */
  closeDelayMs?: number;
};

/**
 * 统一的 HoverCard 行为：
 * - 悬停 `openDelayMs` 后才打开
 * - 离开 `closeDelayMs` 后关闭（缓冲抖动）
 */
export function useHoverCard(options?: HoverCardOptions): HoverHandlers {
  const openDelayMs = Math.max(0, Number(options?.openDelayMs ?? 200));
  const closeDelayMs = Math.max(0, Number(options?.closeDelayMs ?? 120));
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current == null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const clearAllTimers = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearCloseTimer, clearOpenTimer]);

  const onEnter = useCallback(() => {
    clearCloseTimer();
    if (open) return;
    if (openDelayMs === 0) {
      setOpen(true);
      return;
    }
    if (openTimerRef.current != null) return;
    openTimerRef.current = window.setTimeout(() => {
      setOpen(true);
      openTimerRef.current = null;
    }, openDelayMs);
  }, [clearCloseTimer, open, openDelayMs]);

  const onLeave = useCallback(() => {
    clearOpenTimer();
    if (!open) return;
    if (closeDelayMs === 0) {
      setOpen(false);
      return;
    }
    if (closeTimerRef.current != null) return;
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, closeDelayMs);
  }, [clearOpenTimer, closeDelayMs, open]);

  useEffect(() => () => clearAllTimers(), [clearAllTimers]);

  return { open, onEnter, onLeave };
}

