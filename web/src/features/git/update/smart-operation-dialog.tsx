import React from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, FileWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resolveGitTextWith } from "../git-i18n";
import type { GitUpdateOperationProblem, UpdateOperationDialogProps } from "./types";

/**
 * 根据问题类型生成对话框角标文案，便于用户快速区分本地改动与未跟踪文件。
 */
function getProblemKindLabel(
  problem: GitUpdateOperationProblem,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : fallback;
  };
  if (problem.kind === "merge-conflict") return resolveLabel("dialogs.smartOperation.kinds.conflict", "冲突");
  return problem.kind === "local-changes-overwritten"
    ? resolveLabel("dialogs.smartOperation.kinds.localChanges", "本地改动")
    : resolveLabel("dialogs.smartOperation.kinds.untrackedFiles", "未跟踪文件");
}

/**
 * 根据问题来源操作生成展示文案，避免对话框固定写死为 Merge。
 */
function getProblemOperationLabel(
  problem: GitUpdateOperationProblem,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : fallback;
  };
  if (problem.operation === "reset") return resolveLabel("dialogs.smartOperation.operations.reset", "重置");
  if (problem.operation === "checkout") return resolveLabel("dialogs.smartOperation.operations.checkout", "签出");
  if (problem.operation === "cherry-pick") return resolveLabel("dialogs.smartOperation.operations.cherryPick", "优选");
  return resolveLabel("dialogs.smartOperation.operations.merge", "合并");
}

/**
 * 将问题动作的视觉语义映射为按钮样式，保证主次操作层级清晰。
 */
function getProblemActionVariant(action: GitUpdateOperationProblem["actions"][number]): "default" | "secondary" | "danger" {
  if (action.variant === "danger") return "danger";
  if (action.variant === "primary") return "default";
  return "secondary";
}

/**
 * 按操作语义细化“查看受影响内容”按钮文案；Cherry-pick 本地改动覆盖时对齐 IDEA，使用“显示文件”。
 */
function getViewChangesButtonLabel(
  problem: GitUpdateOperationProblem,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : fallback;
  };
  if (problem.operation === "cherry-pick" && problem.kind === "local-changes-overwritten")
    return resolveLabel("dialogs.smartOperation.viewChanges.showFiles", "显示文件");
  return resolveLabel("dialogs.smartOperation.viewChanges.default", "查看这些变更");
}

/**
 * 渲染 smart operation 覆盖文件提示对话框，统一承载“本地改动 / 未跟踪文件”列表展示。
 */
export function SmartOperationDialog(props: UpdateOperationDialogProps): JSX.Element | null {
  const { t } = useTranslation("git");
  const gt = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const { open, problem, submitting, onClose, onViewChanges, onAction } = props;
  if (!problem) return null;
  const canViewChanges = problem.kind === "local-changes-overwritten" && typeof onViewChanges === "function";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent className="cf-git-dialog-panel w-[720px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-[var(--cf-orange)]" />
            {problem.title}
          </DialogTitle>
          <DialogDescription>{problem.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--cf-text-secondary)]">
            <Badge variant="secondary" className="text-[10px]">{getProblemKindLabel(problem, gt)}</Badge>
            <span>
              {problem.files.length > 0
                ? gt("dialogs.smartOperation.summary.withFiles", "共 {{count}} 个文件需要处理后才能继续本次 {{operation}}。", {
                    count: problem.files.length,
                    operation: getProblemOperationLabel(problem, gt),
                  })
                : gt("dialogs.smartOperation.summary.noFiles", "当前问题需要先处理后才能继续本次 {{operation}}。", {
                    operation: getProblemOperationLabel(problem, gt),
                  })}
            </span>
            {problem.rootName ? (
              <Badge variant="secondary" className="text-[10px]">
                {gt("dialogs.smartOperation.summary.repository", "仓库：{{name}}", { name: problem.rootName })}
              </Badge>
            ) : null}
          </div>
          {problem.files.length > 0 ? (
            <div className="max-h-[52vh] overflow-auto rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)]">
              <div className="border-b border-[var(--cf-border)] px-3 py-2 text-[11px] text-[var(--cf-text-secondary)]">
                {gt("dialogs.smartOperation.affectedFiles", "受影响文件")}
              </div>
              <div className="divide-y divide-[var(--cf-border)]">
                {problem.files.map((filePath) => (
                  <div key={filePath} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--cf-orange)]" />
                    <code className="break-all text-[var(--cf-text-primary)]">{filePath}</code>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-3 text-sm text-[var(--cf-text-primary)]">
              {gt("dialogs.smartOperation.emptyFiles", "当前问题未附带文件列表，请根据上方说明先处理仓库状态后再继续。")}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-4">
          {canViewChanges ? (
            <Button
              size="xs"
              variant="secondary"
              disabled={submitting}
              onClick={() => {
                onViewChanges?.();
              }}
            >
              {getViewChangesButtonLabel(problem, gt)}
            </Button>
          ) : null}
          <Button size="xs" variant="secondary" disabled={submitting} onClick={onClose}>
            {gt("dialogs.smartOperation.acknowledge", "我知道了")}
          </Button>
          {problem.actions.map((action) => (
            <div key={`${action.kind}:${action.label}`} className="flex max-w-[220px] flex-col items-end gap-1">
              <Button
                size="xs"
                variant={getProblemActionVariant(action)}
                disabled={submitting}
                onClick={() => {
                  onAction(action.payloadPatch || {});
                }}
              >
                {action.label}
              </Button>
              {action.description ? (
                <div className="max-w-[220px] text-right text-[11px] leading-4 text-[var(--cf-text-secondary)]">
                  {action.description}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
