import React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveGitTextWith } from "../git-i18n";
import type {
  GitUpdatePostAction,
  GitUpdateSessionNotificationData,
  GitUpdateSessionProgressSnapshot,
} from "./types";
import type {
  GitUpdateSessionResultRootViewState,
  GitUpdateSessionResultViewState,
  GitUpdateSessionViewRoot,
} from "./session-store";
import { buildUpdateSessionViewState } from "./session-store";

type ResultNotificationProps = {
  notification?: GitUpdateSessionNotificationData | null;
  resultView?: GitUpdateSessionResultViewState | null;
  expanded: boolean;
  consoleFocused?: boolean;
  onToggleExpanded(): void;
  onFocusConsole(): void;
  onPostAction(action: GitUpdatePostAction): void;
};

type UpdateSessionProgressCardProps = {
  message: string;
  snapshot?: GitUpdateSessionProgressSnapshot;
  expanded: boolean;
  consoleFocused?: boolean;
  onToggleExpanded(): void;
  onFocusConsole(): void;
  onPostAction(action: GitUpdatePostAction): void;
};

/**
 * 把提交范围格式化为适合结果卡片展示的短文本，避免直接暴露过长哈希。
 */
function formatRangeText(notification: GitUpdateSessionNotificationData): string {
  const primaryRange = notification.primaryRange || notification.ranges[0];
  if (!primaryRange) return "";
  const start = primaryRange.range.start.slice(0, 8);
  const end = primaryRange.range.end.slice(0, 8);
  return `${primaryRange.rootName} · ${start}..${end}`;
}

/**
 * 把 Update Session 后置动作统一映射为可翻译标签；未知动作保留原始文案，避免前后端新增动作时入口消失。
 */
function resolveUpdatePostActionLabel(
  action: GitUpdatePostAction,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  const rawLabel = String(action.label || "").trim();
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : fallback;
  };
  if (action.kind === "view-commits") return resolveLabel("dialogs.updateResult.postActions.viewCommits", rawLabel || "查看提交");
  if (action.kind === "copy-revision-range") return resolveLabel("dialogs.updateResult.postActions.copyRevisionRange", rawLabel || "复制提交范围");
  if (action.kind === "open-saved-changes") return resolveLabel("dialogs.updateResult.postActions.openSavedChanges", rawLabel || "查看已保存改动");
  if (action.kind === "resolve-conflicts") return resolveLabel("dialogs.updateResult.postActions.resolveConflicts", rawLabel || "处理该仓冲突");
  if (action.kind === "fix-tracked-branch") return resolveLabel("dialogs.updateResult.postActions.fixTrackedBranch", rawLabel || "修复上游分支");
  if (action.kind === "open-parent-repo") return resolveLabel("dialogs.updateResult.postActions.openParentRepo", rawLabel || "打开父仓");
  if (action.kind === "open-repo-root") return resolveLabel("dialogs.updateResult.postActions.openRepoRoot", rawLabel || "打开该仓");
  if (action.kind === "retry-update-root") return resolveLabel("dialogs.updateResult.postActions.retryUpdateRoot", rawLabel || "重试该仓更新");
  return rawLabel;
}

/**
 * 为运行态 root 行渲染统一的状态徽标，保证活动仓与已完成仓在视觉上可快速区分。
 */
function renderRunningRootRow(
  root: GitUpdateSessionViewRoot,
  onPostAction: (action: GitUpdatePostAction) => void,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): JSX.Element {
  return (
    <div
      key={root.repoRoot}
      className="flex items-start justify-between gap-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2.5 py-2"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{root.rootName}</span>
          {root.kind === "submodule" ? (
            <Badge variant="secondary" className="text-[10px]">{resolveText ? resolveText("dialogs.updateScope.kind.submodule", "子模块") : "子模块"}</Badge>
          ) : null}
          {root.isActive ? (
            <Badge variant="secondary" className="text-[10px]">{resolveText ? resolveText("dialogs.updateResult.running.current", "当前") : "当前"}</Badge>
          ) : null}
        </div>
        <div className="mt-1 text-[11px] opacity-80">{root.summaryLabel}</div>
        {root.badges.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {root.badges.map((badge) => (
              <Badge key={`${root.repoRoot}:${badge}`} variant="outline" className="text-[10px]">
                {badge}
              </Badge>
            ))}
          </div>
        ) : null}
        {root.detailLines.length > 0 ? (
          <div className="mt-2 space-y-1">
            {root.detailLines.slice(0, 3).map((line) => (
              <div key={`${root.repoRoot}:${line}`} className="text-[11px] opacity-80">{line}</div>
            ))}
          </div>
        ) : null}
        {root.actions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {root.actions.map((action) => (
              <Button
                key={`${root.repoRoot}:${action.kind}`}
                size="xs"
                variant="secondary"
                onClick={() => onPostAction(action)}
              >
                {resolveUpdatePostActionLabel(action, resolveText)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {root.resultLabel ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {root.resultLabel}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * 为完成态 root 行渲染统一详情，保证更新方式、范围和错误原因都能在一处查看。
 */
function renderResultRootRow(
  root: GitUpdateSessionResultRootViewState,
  onPostAction: (action: GitUpdatePostAction) => void,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): JSX.Element {
  return (
    <div
      key={root.repoRoot}
      className="flex items-start justify-between gap-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2.5 py-2"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{root.rootName}</span>
          {root.kind === "submodule" ? (
            <Badge variant="secondary" className="text-[10px]">{resolveText ? resolveText("dialogs.updateScope.kind.submodule", "子模块") : "子模块"}</Badge>
          ) : null}
          {root.methodLabel ? (
            <Badge variant="secondary" className="text-[10px]">{root.methodLabel}</Badge>
          ) : null}
        </div>
        <div className="mt-1 text-[11px] opacity-80">{root.detail}</div>
        {root.badges.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {root.badges.map((badge) => (
              <Badge key={`${root.repoRoot}:${badge}`} variant="outline" className="text-[10px]">
                {badge}
              </Badge>
            ))}
          </div>
        ) : null}
        {root.detailLines.length > 0 ? (
          <div className="mt-2 space-y-1">
            {root.detailLines.map((line) => (
              <div key={`${root.repoRoot}:${line}`} className="text-[11px] opacity-80">{line}</div>
            ))}
          </div>
        ) : null}
        {root.actions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {root.actions.map((action) => (
              <Button
                key={`${root.repoRoot}:${action.kind}`}
                size="xs"
                variant="secondary"
                onClick={() => onPostAction(action)}
              >
                {resolveUpdatePostActionLabel(action, resolveText)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <Badge variant={root.isProblematic ? "danger" : "secondary"} className="shrink-0 text-[10px]">
        {root.resultLabel}
      </Badge>
    </div>
  );
}

/**
 * 渲染 Update Project 结果通知卡片，统一承载统计摘要、root 详情与“查看提交”入口。
 */
export function ResultNotification(props: ResultNotificationProps): JSX.Element {
  const { t } = useTranslation("git");
  const gt = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const { notification, onPostAction, resultView } = props;
  const rangeText = resultView?.rangeText || (notification ? formatRangeText(notification) : "");
  const skippedRoots = notification?.skippedRoots.slice(0, 3) || [];
  const postActions = [...(notification?.postActions || []), ...(resultView?.postActions || [])].filter((action, index, list) => {
    const key = `${action.kind}:${action.repoRoot || ""}:${action.revision || ""}`;
    return list.findIndex((candidate) => `${candidate.kind}:${candidate.repoRoot || ""}:${candidate.revision || ""}` === key) === index;
  });
  const resultRoots = resultView?.roots || [];
  const title = notification?.title || resultView?.title || gt("dialogs.updateResult.defaultTitle", "更新项目已完成");
  const description = notification?.description || resultView?.description;
  const updatedFilesCount = notification?.updatedFilesCount ?? resultView?.updatedFilesCount;
  const receivedCommitsCount = notification?.receivedCommitsCount ?? resultView?.receivedCommitsCount;
  const filteredCommitsCount = notification?.filteredCommitsCount ?? resultView?.filteredCommitsCount;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{title}</span>
            {typeof updatedFilesCount === "number" ? (
              <Badge variant="secondary" className="text-[10px]">
                {gt("dialogs.updateResult.counts.files", "文件 {{count}}", { count: updatedFilesCount })}
              </Badge>
            ) : null}
            {typeof receivedCommitsCount === "number" ? (
              <Badge variant="secondary" className="text-[10px]">
                {gt("dialogs.updateResult.counts.commits", "提交 {{count}}", { count: receivedCommitsCount })}
              </Badge>
            ) : null}
            {typeof filteredCommitsCount === "number" ? (
              <Badge variant="secondary" className="text-[10px]">
                {gt("dialogs.updateResult.counts.filteredCommits", "可查看 {{count}}", { count: filteredCommitsCount })}
              </Badge>
            ) : null}
          </div>
          {description ? (
            <div className="text-[11px] opacity-80">{description}</div>
          ) : null}
          {rangeText ? (
            <div className="truncate text-[11px] opacity-80">{gt("dialogs.updateResult.range", "范围：{{range}}", { range: rangeText })}</div>
          ) : null}
          {resultView?.skippedSummary ? (
            <div className="text-[11px] opacity-80">{resultView.skippedSummary}</div>
          ) : null}
          {skippedRoots.length > 0 ? (
            <div className="text-[11px] opacity-80">
              {gt("dialogs.updateResult.skippedRoots", "跳过仓库：{{roots}}", {
                roots: skippedRoots.map((root) => `${root.rootName}（${root.reason}）`).join("、"),
              })}
              {notification && notification.skippedRoots.length > skippedRoots.length
                ? gt("dialogs.updateResult.skippedRootsMore", " 等 {{count}} 个", { count: notification.skippedRoots.length })
                : ""}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button size="xs" variant={props.consoleFocused ? "default" : "secondary"} onClick={props.onFocusConsole}>
            {props.consoleFocused
              ? gt("dialogs.updateResult.console.focused", "已聚焦控制台")
              : gt("dialogs.updateResult.console.default", "查看控制台")}
          </Button>
          {resultRoots.length > 0 ? (
            <Button size="xs" variant="secondary" onClick={props.onToggleExpanded}>
              {props.expanded
                ? gt("dialogs.updateResult.expand.collapse", "收起详情")
                : gt("dialogs.updateResult.expand.expand", "展开详情（{{count}}）", { count: resultRoots.length })}
            </Button>
          ) : null}
          {postActions.map((action) => (
            <Button
              key={`${action.kind}:${action.label}`}
              size="xs"
              variant="secondary"
              onClick={() => onPostAction(action)}
            >
              {resolveUpdatePostActionLabel(action, gt)}
            </Button>
          ))}
        </div>
      </div>
      {props.expanded && resultRoots.length > 0 ? (
        <div className="space-y-2">
          {resultRoots.map((root) => renderResultRootRow(root, onPostAction, gt))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 渲染运行中的 Update Session 卡片，展示当前 root、当前阶段与各 root 进度摘要。
 */
export function UpdateSessionProgressCard(props: UpdateSessionProgressCardProps): JSX.Element | null {
  const { t } = useTranslation("git");
  const gt = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const viewState = buildUpdateSessionViewState(props.snapshot);
  if (!viewState) {
    return (
      <div className="space-y-2">
        <div className="font-medium">{props.message || gt("dialogs.updateResult.running.preparing", "正在准备 Update Session")}</div>
        <div className="text-[11px] opacity-80">{gt("dialogs.updateResult.running.waitingForSnapshot", "主进程已启动更新流程，正在等待首个会话快照。")}</div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant={props.consoleFocused ? "default" : "secondary"} onClick={props.onFocusConsole}>
            {props.consoleFocused
              ? gt("dialogs.updateResult.console.focused", "已聚焦控制台")
              : gt("dialogs.updateResult.console.default", "查看控制台")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">
              {viewState.activeRootName ? `${viewState.activeRootName} · ${viewState.activePhaseLabel}` : viewState.activePhaseLabel}
            </span>
            <Badge variant="secondary" className="text-[10px]">
              {gt("dialogs.updateResult.running.completed", "已完成 {{completed}}/{{total}}", {
                completed: viewState.completedRoots,
                total: viewState.totalRoots,
              })}
            </Badge>
            {viewState.runningRoots > 0 ? (
              <Badge variant="secondary" className="text-[10px]">
                {gt("dialogs.updateResult.running.running", "运行中 {{count}}", { count: viewState.runningRoots })}
              </Badge>
            ) : null}
            {viewState.remainingRoots > 0 ? (
              <Badge variant="secondary" className="text-[10px]">
                {gt("dialogs.updateResult.running.remaining", "剩余 {{count}}", { count: viewState.remainingRoots })}
              </Badge>
            ) : null}
          </div>
          <div className="text-[11px] opacity-80">
            {viewState.multiRoot
              ? gt("dialogs.updateResult.running.multiRootHint", "当前为多仓 Update Session，以下可查看各 root 的实时阶段与收口状态。")
              : gt("dialogs.updateResult.running.singleRootHint", "当前为单仓 Update Session。")}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button size="xs" variant={props.consoleFocused ? "default" : "secondary"} onClick={props.onFocusConsole}>
            {props.consoleFocused
              ? gt("dialogs.updateResult.console.focused", "已聚焦控制台")
              : gt("dialogs.updateResult.console.default", "查看控制台")}
          </Button>
          <Button size="xs" variant="secondary" onClick={props.onToggleExpanded}>
            {props.expanded
              ? gt("dialogs.updateResult.expand.collapse", "收起详情")
              : gt("dialogs.updateResult.expand.expand", "展开详情（{{count}}）", { count: viewState.roots.length })}
          </Button>
        </div>
      </div>
      {props.expanded ? (
        <div className="space-y-2">
          {viewState.roots.map((root) => renderRunningRootRow(root, props.onPostAction, gt))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {viewState.roots.slice(0, 6).map((root) => (
            <Badge key={root.repoRoot} variant="secondary" className="max-w-full gap-1 text-[10px]">
              <span className="truncate">{root.rootName}</span>
              <span className="opacity-70">{root.summaryLabel}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
