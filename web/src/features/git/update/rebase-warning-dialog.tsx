import React from "react";
import { AlertTriangle, GitCommitHorizontal, GitMerge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { interpolateI18nText } from "@/lib/translate";
import type { GitUpdateRebaseWarning } from "./types";

type RebaseWarningDialogProps = {
  open: boolean;
  warning: GitUpdateRebaseWarning | null;
  submitting: boolean;
  onClose(): void;
  onConfirm(payloadPatch: Record<string, any>): void;
  onAlternative?(payloadPatch: Record<string, any>): void;
};

/**
 * 把 rebase warning 类型转成顶部角标，帮助用户快速识别风险来源。
 */
function getRebaseWarningKindLabel(
  warning: GitUpdateRebaseWarning,
  resolveLabel: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  return warning.type === "published-commits"
    ? resolveLabel("dialogs.rebaseWarning.kind.publishedCommits", "已发布提交")
    : resolveLabel("dialogs.rebaseWarning.kind.mergeCommits", "合并提交");
}

/**
 * 为 rebase warning 选择主图标，避免两类提示在视觉上完全相同。
 */
function getRebaseWarningIcon(warning: GitUpdateRebaseWarning): JSX.Element {
  if (warning.type === "merge-commits") {
    return <GitMerge className="h-4 w-4 text-[var(--cf-orange)]" />;
  }
  return <GitCommitHorizontal className="h-4 w-4 text-[var(--cf-orange)]" />;
}

/**
 * 渲染 Rebase 专属 warning 对话框，承载“继续 Rebase / 改用 Merge / 取消”决策。
 */
export function RebaseWarningDialog(props: RebaseWarningDialogProps): JSX.Element | null {
  const { t } = useTranslation("git");
  const {
    open,
    warning,
    submitting,
    onClose,
    onConfirm,
    onAlternative,
  } = props;
  if (!warning) return null;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, {
      ns: "git",
      defaultValue: fallback,
      ...(values || {}),
    })), values);
  }, [t]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent className="cf-git-dialog-panel w-[680px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-[var(--cf-orange)]" />
            {warning.title}
          </DialogTitle>
          <DialogDescription>{warning.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--cf-text-secondary)]">
            <Badge variant="secondary" className="text-[10px]">{getRebaseWarningKindLabel(warning, gt)}</Badge>
            <span className="inline-flex items-center gap-1.5">
              {getRebaseWarningIcon(warning)}
              {gt("dialogs.rebaseWarning.currentMode", "当前更新方式为 {{method}}", { method: gt("dialogs.updateOptions.methods.rebase.title", "变基") })}
            </span>
          </div>
          {warning.details ? (
            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-3 text-sm text-[var(--cf-text-primary)]">
              {warning.details}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-4">
          <Button size="xs" variant="secondary" disabled={submitting} onClick={onClose}>
            {warning.cancelText || gt("dialogs.rebaseWarning.cancel", "取消")}
          </Button>
          {warning.alternativeAction ? (
            <Button
              size="xs"
              variant="secondary"
              disabled={submitting}
              onClick={() => {
                if (!warning.alternativeAction || !onAlternative) return;
                onAlternative(warning.alternativeAction.payloadPatch || {});
              }}
            >
              {warning.alternativeAction.label}
            </Button>
          ) : null}
          <Button
            size="xs"
            disabled={submitting}
            onClick={() => {
              onConfirm(warning.confirmAction.payloadPatch || {});
            }}
          >
            {warning.confirmAction.label}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
