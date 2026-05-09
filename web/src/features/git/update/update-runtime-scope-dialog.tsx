import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { resolveGitTextWith, resolveGitUpdateMethodLabel } from "../git-i18n";
import type { GitUpdateOptionsSnapshot } from "./types";
import {
  buildRuntimeUpdateScopePayload,
  canToggleScopeRoot,
  dedupeRepoRoots,
  getScopeSourceLabel,
  sortScopePreviewRoots,
  toRepoRootKey,
} from "./scope-preview";

type UpdateRuntimeScopeDialogProps = {
  open: boolean;
  snapshot: GitUpdateOptionsSnapshot;
  submitting?: boolean;
  onClose(): void;
  onConfirm(payloadPatch: Record<string, any>): void;
};

/**
 * 运行期作用域选择对话框，允许用户在不改持久化默认值的前提下调整本次 Update Project 的仓库范围。
 */
export function UpdateRuntimeScopeDialog(props: UpdateRuntimeScopeDialogProps): React.ReactElement {
  const { t } = useTranslation("git");
  const gt = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const { open, snapshot, submitting } = props;
  const [includedRepoRoots, setIncludedRepoRoots] = useState<string[]>(snapshot.scopePreview.includedRepoRoots);

  useEffect(() => {
    if (!open) return;
    setIncludedRepoRoots(snapshot.scopePreview.includedRepoRoots);
  }, [open, snapshot.scopePreview.includedRepoRoots]);

  const sortedRoots = useMemo(
    () => sortScopePreviewRoots(snapshot.scopePreview.roots),
    [snapshot.scopePreview.roots],
  );
  const includedKeySet = useMemo(
    () => new Set(includedRepoRoots.map((repoRoot) => toRepoRootKey(repoRoot)).filter(Boolean)),
    [includedRepoRoots],
  );
  const includedCount = includedRepoRoots.length;
  const branchName = String(snapshot.methodResolution.currentBranch || "").trim();
  const detachedRoots = useMemo(
    () => sortedRoots.filter((root) => root.detachedHead),
    [sortedRoots],
  );
  const skippedRoots = snapshot.scopePreview.skippedRoots;

  /**
   * 切换本次运行时是否纳入指定仓库；当前仓固定保留，其他仓按 repo key 去重维护。
   */
  const toggleRuntimeRoot = (repoRoot: string, nextIncluded: boolean): void => {
    const repoKey = toRepoRootKey(repoRoot);
    setIncludedRepoRoots((prev) => {
      const nextKeys = new Set(prev.map((item) => toRepoRootKey(item)).filter(Boolean));
      if (nextIncluded) nextKeys.add(repoKey);
      else nextKeys.delete(repoKey);
      return dedupeRepoRoots(
        snapshot.scopePreview.roots
          .map((root) => root.repoRoot)
          .filter((rootPath) => {
            const rootKey = toRepoRootKey(rootPath);
            if (!rootKey) return false;
            if (rootKey === toRepoRootKey(snapshot.scopePreview.requestedRepoRoot)) return true;
            return nextKeys.has(rootKey);
          }),
      );
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) props.onClose();
      }}
    >
      <DialogContent className="max-w-[820px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0 text-[var(--cf-text-primary)]">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="text-base font-semibold">{gt("dialogs.updateRuntimeScope.title", "选择本次更新范围")}</DialogTitle>
          <DialogDescription className="text-xs text-[var(--cf-text-secondary)]">
            {gt("dialogs.updateRuntimeScope.description", "仅影响这一次更新项目；保存的默认范围与多仓设置不会被改写。")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[72vh] space-y-4 overflow-auto px-5 py-4">
          <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">{gt("dialogs.updateRuntimeScope.badges.currentRun", "本次执行")}</Badge>
              <span className="text-sm font-medium">
                {branchName
                  ? gt("dialogs.updateRuntimeScope.summary.branch", "分支 {{branch}}", { branch: branchName })
                  : gt("dialogs.updateRuntimeScope.summary.detached", "游离 HEAD / 当前分支待解析")}
              </span>
              <Badge className="bg-[var(--cf-accent)] text-white">
                {resolveGitUpdateMethodLabel(snapshot.options.updateMethod, gt) || gt("dialogs.updateOptions.methods.merge.title", "合并")}
              </Badge>
            </div>
            <div className="mt-2 text-xs text-[var(--cf-text-secondary)]">
              {gt("dialogs.updateRuntimeScope.summary.selection", "已选择 {{count}} 个仓库；本次确认后会显式把所选范围写入本次执行参数，不会覆盖默认配置。", {
                count: includedCount,
              })}
            </div>
          </section>

          <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-4">
            <div className="mb-3">
              <div className="text-sm font-medium">{gt("dialogs.updateRuntimeScope.risk.title", "执行风险")}</div>
              <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                {gt("dialogs.updateRuntimeScope.risk.description", "这里优先展示会直接影响多仓更新行为的游离 HEAD / 跳过 / 子模块差异。")}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="text-[10px]">{gt("dialogs.updateRuntimeScope.badges.included", "已纳入 {{count}}", { count: includedCount })}</Badge>
              {detachedRoots.length > 0 ? (
                <Badge className="bg-[var(--cf-yellow-light)] text-[var(--cf-warning-foreground)]">
                  {gt("dialogs.updateRuntimeScope.badges.detachedHead", "游离 HEAD {{count}}", { count: detachedRoots.length })}
                </Badge>
              ) : null}
              {skippedRoots.length > 0 ? (
                <Badge variant="outline" className="text-[10px]">{gt("dialogs.updateRuntimeScope.badges.defaultSkipped", "默认跳过 {{count}}", { count: skippedRoots.length })}</Badge>
              ) : null}
            </div>
            {detachedRoots.length > 0 ? (
              <div className="mt-3 text-xs leading-5 text-[var(--cf-text-secondary)]">
                {gt("dialogs.updateRuntimeScope.risk.detachedNote", "游离 HEAD 的普通仓通常会在预检阶段被跳过；游离 HEAD 子模块则可能走“由父仓递归更新”或“独立更新器”两种路径。")}
              </div>
            ) : null}
          </section>

          <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-4">
            <div className="mb-3">
              <div className="text-sm font-medium">{gt("dialogs.updateRuntimeScope.repositories.title", "仓库列表")}</div>
              <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                {gt("dialogs.updateRuntimeScope.repositories.description", "当前仓固定纳入；关联仓、普通嵌套仓和子模块可按本次执行单独勾选。")}
              </div>
            </div>
            <div className="space-y-2">
              {sortedRoots.map((root) => {
                const disabled = !canToggleScopeRoot(root);
                const checked = includedKeySet.has(toRepoRootKey(root.repoRoot));
                return (
                  <label
                    key={root.repoRoot}
                    className={cn(
                      "flex items-start gap-3 rounded-apple border px-3 py-3 transition-colors",
                      checked
                        ? "border-[var(--cf-border)] bg-[var(--cf-surface-muted)]"
                        : "border-[var(--cf-border)] bg-[var(--cf-surface)] opacity-85",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={checked}
                      disabled={disabled || submitting}
                      onChange={(event) => {
                        toggleRuntimeRoot(root.repoRoot, event.target.checked);
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{root.rootName}</span>
                        <Badge variant="secondary" className="text-[10px]">{getScopeSourceLabel(root.source, gt)}</Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {root.kind === "submodule"
                            ? gt("dialogs.updateScope.kind.submodule", "子模块")
                            : gt("dialogs.updateScope.kind.repository", "仓库")}
                        </Badge>
                        {disabled ? <Badge className="bg-[var(--cf-accent-light)] text-[var(--cf-text-primary)]">{gt("dialogs.updateRuntimeScope.badges.fixedIncluded", "固定纳入")}</Badge> : null}
                        {root.detachedHead ? <Badge className="bg-[var(--cf-yellow-light)] text-[var(--cf-warning-foreground)]">{gt("dialogs.updateScope.detachedHead", "游离 HEAD")}</Badge> : null}
                      </div>
                      <div className="mt-1 truncate text-[11px] text-[var(--cf-text-secondary)]">{root.repoRoot}</div>
                      {root.parentRepoRoot ? (
                        <div className="mt-1 truncate text-[11px] text-[var(--cf-text-secondary)]">{gt("dialogs.updateRuntimeScope.repositories.parentRepository", "父仓：{{path}}", { path: root.parentRepoRoot })}</div>
                      ) : null}
                      {root.detachedHead ? (
                        <div className="mt-1 text-[11px] text-[var(--cf-warning-foreground)]">
                          {gt("dialogs.updateRuntimeScope.repositories.detachedNote", "该仓库当前处于游离 HEAD，运行时可能被跳过或转为特殊子模块更新路径。")}
                        </div>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </div>
          </section>

          {skippedRoots.length > 0 ? (
            <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-4">
              <div className="mb-3">
                <div className="text-sm font-medium">{gt("dialogs.updateRuntimeScope.skipped.title", "本次默认跳过")}</div>
                <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                  {gt("dialogs.updateRuntimeScope.skipped.description", "这些仓库当前不会进入执行仓库列表，原因来自仓库图或跟踪分支解析结果。")}
                </div>
              </div>
              <div className="space-y-2">
                {skippedRoots.map((root) => (
                  <div key={`${root.repoRoot}:${root.reasonCode}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{root.rootName}</span>
                      <Badge variant="secondary" className="text-[10px]">{root.kind === "submodule" ? gt("dialogs.updateScope.kind.submodule", "子模块") : gt("dialogs.updateScope.kind.repository", "仓库")}</Badge>
                      <Badge className="bg-[var(--cf-accent-light)] text-[var(--cf-text-primary)]">{root.reasonCode}</Badge>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-[var(--cf-text-secondary)]">{root.repoRoot}</div>
                    <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">{root.reason}</div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-4">
          <Button size="xs" variant="secondary" onClick={props.onClose} disabled={submitting}>
            {gt("dialogs.updateRuntimeScope.cancel", "取消")}
          </Button>
          <Button
            size="xs"
            onClick={() => props.onConfirm(buildRuntimeUpdateScopePayload(snapshot.options, snapshot.scopePreview, includedRepoRoots))}
            disabled={submitting || includedCount <= 0}
          >
            {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            {gt("dialogs.updateRuntimeScope.confirm", "按当前选择继续")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
