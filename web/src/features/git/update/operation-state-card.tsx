import React from "react";
import { AlertTriangle, Loader2, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { interpolateI18nText } from "@/lib/translate";

type GitRepositoryOperationState = "normal" | "rebasing" | "merging" | "grafting" | "reverting";

type OperationStateCardProps = {
  state?: GitRepositoryOperationState;
  unresolvedConflictCount: number;
  resolvedConflictCount: number;
  submitting: "continue" | "abort" | null;
  continueLabelOverride?: string;
  hintOverride?: string;
  onResolveConflicts?(): void;
  onContinue(): void;
  onAbort(): void;
};

type OperationStatePresentation = {
  title: string;
  badge: string;
  continueLabel: string;
  abortLabel: string;
};

/**
 * 把仓库进行中状态映射为统一展示文案，避免工作台与测试里散落硬编码。
 */
function getOperationStatePresentation(
  state: GitRepositoryOperationState | undefined,
  resolveLabel: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): OperationStatePresentation | null {
  if (!state || state === "normal") return null;
  if (state === "rebasing") {
    return {
      title: resolveLabel("workbench.operationState.states.rebasing.title", "当前仓库处于变基过程中"),
      badge: resolveLabel("workbench.operationState.states.rebasing.badge", "变基"),
      continueLabel: resolveLabel("workbench.operationState.states.rebasing.continueLabel", "继续变基"),
      abortLabel: resolveLabel("workbench.operationState.states.rebasing.abortLabel", "中止变基"),
    };
  }
  if (state === "merging") {
    return {
      title: resolveLabel("workbench.operationState.states.merging.title", "当前仓库处于合并过程中"),
      badge: resolveLabel("workbench.operationState.states.merging.badge", "合并"),
      continueLabel: resolveLabel("workbench.operationState.states.merging.continueLabel", "继续合并"),
      abortLabel: resolveLabel("workbench.operationState.states.merging.abortLabel", "中止合并"),
    };
  }
  if (state === "grafting") {
    return {
      title: resolveLabel("workbench.operationState.states.grafting.title", "当前仓库处于优选过程中"),
      badge: resolveLabel("workbench.operationState.states.grafting.badge", "优选"),
      continueLabel: resolveLabel("workbench.operationState.states.grafting.continueLabel", "继续优选"),
      abortLabel: resolveLabel("workbench.operationState.states.grafting.abortLabel", "中止优选"),
    };
  }
  return {
    title: resolveLabel("workbench.operationState.states.reverting.title", "当前仓库处于还原过程中"),
    badge: resolveLabel("workbench.operationState.states.reverting.badge", "还原"),
    continueLabel: resolveLabel("workbench.operationState.states.reverting.continueLabel", "继续还原"),
    abortLabel: resolveLabel("workbench.operationState.states.reverting.abortLabel", "中止还原"),
  };
}

/**
 * 根据冲突数量生成辅助说明，帮助用户理解何时可以直接 continue。
 */
function getOperationStateHint(
  unresolvedConflictCount: number,
  resolvedConflictCount: number,
  resolveLabel: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  if (unresolvedConflictCount > 0) {
    return resolveLabel("workbench.operationState.hints.unresolved", "还有 {{count}} 个文件存在未解决冲突，请先在提交面板或外部工具中完成处理。", { count: unresolvedConflictCount });
  }
  if (resolvedConflictCount > 0) {
    return resolveLabel("workbench.operationState.hints.resolved", "已有 {{count}} 个冲突文件完成解析，现在可以继续或中止当前操作。", { count: resolvedConflictCount });
  }
  return resolveLabel("workbench.operationState.hints.clean", "当前仓库没有未解决冲突文件，可以直接继续或中止该操作。");
}

/**
 * 渲染进行中 Git 操作提示条，把 continue / abort 收口为统一入口。
 */
export function OperationStateCard(props: OperationStateCardProps): React.ReactElement | null {
  const { t } = useTranslation("git");
  const {
    state,
    unresolvedConflictCount,
    resolvedConflictCount,
    submitting,
    continueLabelOverride,
    hintOverride,
    onResolveConflicts,
    onContinue,
    onAbort,
  } = props;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, {
      ns: "git",
      defaultValue: fallback,
      ...(values || {}),
    })), values);
  }, [t]);
  const presentation = getOperationStatePresentation(state, gt);
  if (!presentation) return null;

  const continueDisabled = submitting !== null || unresolvedConflictCount > 0;
  const abortDisabled = submitting !== null;

  return (
    <div
      className="border-b border-[var(--cf-border)] bg-[var(--cf-yellow-light)]/80 px-3 py-2 text-xs text-[var(--cf-warning-foreground)]"
      data-testid="operation-state-card"
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">{presentation.title}</span>
            <Badge variant="secondary" className="text-[10px]">
              {presentation.badge}
            </Badge>
          </div>
          <div className="mt-1 text-[11px] opacity-90" data-testid="operation-state-hint">
            {hintOverride || getOperationStateHint(unresolvedConflictCount, resolvedConflictCount, gt)}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {unresolvedConflictCount > 0 && onResolveConflicts ? (
            <Button
              size="xs"
              variant="secondary"
              disabled={submitting !== null}
              onClick={onResolveConflicts}
              data-testid="operation-state-resolve"
            >
              {gt("workbench.operationState.resolveButton", "解决冲突")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="secondary"
            disabled={continueDisabled}
            onClick={onContinue}
            data-testid="operation-state-continue"
            title={unresolvedConflictCount > 0 ? gt("workbench.operationState.continueDisabled", "仍存在未解决冲突，暂时不能继续") : undefined}
          >
            {submitting === "continue" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
            {continueLabelOverride || presentation.continueLabel}
          </Button>
          <Button
            size="xs"
            variant="danger"
            disabled={abortDisabled}
            onClick={onAbort}
            data-testid="operation-state-abort"
          >
            {submitting === "abort" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1 h-3.5 w-3.5" />}
            {presentation.abortLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
