// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { History as HistoryIcon, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type HistoryPanelToggleButtonProps = {
  /** 中文说明：当前历史面板是否处于展开状态 */
  expanded: boolean;
  /** 中文说明：按钮提示文案（同时用于 title 与 aria-label） */
  label: string;
  /** 中文说明：点击切换历史面板显示/隐藏 */
  onToggle: () => void;
  /** 中文说明：额外样式（不包含定位，定位建议由调用方控制） */
  className?: string;
};

/**
 * 中文说明：历史面板开关按钮（纯图标）。
 * - 折叠状态：仅显示“历史”图标，表达入口语义
 * - 展开状态：仅显示“收起箭头”图标，表达可收起语义
 */
export default function HistoryPanelToggleButton(props: HistoryPanelToggleButtonProps) {
  const { expanded, label, onToggle, className } = props;

  return (
    <Button
      size="icon"
      variant="secondary"
      className={cn("h-9 w-9 relative", className)}
      aria-label={label}
      title={label}
      aria-pressed={expanded}
      onClick={onToggle}
    >
      {expanded ? <ChevronRight className="h-4 w-4" /> : <HistoryIcon className="h-4 w-4" />}
    </Button>
  );
}
