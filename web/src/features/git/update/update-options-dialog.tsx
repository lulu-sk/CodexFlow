import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderPlus, Loader2, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { interpolateI18nText } from "@/lib/translate";
import { cn } from "@/lib/utils";
import type {
  GitUpdateMethod,
  GitUpdateOptionMethod,
  GitUpdateOptions,
  GitUpdateOptionsSnapshot,
  GitUpdateSaveChangesPolicy,
  GitUpdateScopeOptions,
  GitUpdateScopePreview,
  GitUpdateScopePreviewRoot,
  GitUpdateSyncStrategy,
} from "./types";
import {
  canToggleScopeRoot,
  dedupeRepoRoots,
  getScopeSourceLabel,
  sortScopePreviewRoots,
  toRepoRootKey,
} from "./scope-preview";

type UpdateOptionsDialogProps = {
  open: boolean;
  snapshot: GitUpdateOptionsSnapshot;
  submitting?: boolean;
  onClose(): void;
  onConfirm(options: GitUpdateOptions): void;
  onRequestScopePreview?(options: GitUpdateOptions): Promise<GitUpdateScopePreview | null>;
};

type GitUpdateMethodOptionItem = {
  value: GitUpdateOptionMethod;
  title: string;
  description: string;
};

type GitUpdateSavePolicyOptionItem = {
  value: GitUpdateSaveChangesPolicy;
  title: string;
  description: string;
};

type GitUpdateSyncStrategyOptionItem = {
  value: GitUpdateSyncStrategy;
  title: string;
  description: string;
};

type GitUpdateMethodPreview = {
  effectiveMethod: GitUpdateMethod;
  sourceLabel: string;
  detailLabel: string;
};

/**
 * 把更新方式值转换为 UI 可读标签。
 */
function getUpdateMethodLabel(
  value: GitUpdateOptionMethod | GitUpdateMethod,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : fallback;
  };
  switch (value) {
    case "rebase":
      return resolveLabel("dialogs.updateOptions.methods.rebase.title", "变基");
    case "reset":
      return resolveLabel("dialogs.updateOptions.methods.reset.title", "Reset");
    default:
      return resolveLabel("dialogs.updateOptions.methods.merge.title", "合并");
  }
}

/**
 * 根据当前表单值与后端快照推导“当前会如何执行更新”的预览文案。
 */
function resolveMethodPreview(
  _snapshot: GitUpdateOptionsSnapshot,
  formState: GitUpdateOptions,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): GitUpdateMethodPreview {
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveText ? resolveText(key, fallback, values) : fallback;
  };
  return {
    effectiveMethod: formState.updateMethod,
    sourceLabel: resolveLabel("dialogs.updateOptions.preview.sourceLabel", "正式 Update 选项"),
    detailLabel: resolveLabel("dialogs.updateOptions.preview.detailLabel", "已固定为 {{method}}。", {
      method: getUpdateMethodLabel(formState.updateMethod, resolveText),
    }),
  };
}

/**
 * 在作用域配置改变后返回新的表单对象，统一维持仓库列表去重和跳过规则清洗。
 */
function updateScopeOptions(
  prev: GitUpdateOptions,
  patch: Partial<GitUpdateScopeOptions>,
): GitUpdateOptions {
  const nextScope: GitUpdateScopeOptions = {
    ...prev.scope,
    ...patch,
  };
  const linkedRepoRoots = dedupeRepoRoots(nextScope.linkedRepoRoots);
  const skippedRepoRoots = dedupeRepoRoots(nextScope.skippedRepoRoots);
  return {
    ...prev,
    scope: {
      ...nextScope,
      linkedRepoRoots,
      skippedRepoRoots,
    },
  };
}

/**
 * 渲染正式的 Update Project 选项对话框，并补齐多仓范围默认配置与预览。
 */
export function UpdateOptionsDialog({
  open,
  snapshot,
  submitting,
  onClose,
  onConfirm,
  onRequestScopePreview,
}: UpdateOptionsDialogProps): JSX.Element {
  const { t } = useTranslation("git");
  const gt = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, { defaultValue: fallback, ...(values || {}) })), values);
  };
  const [formState, setFormState] = useState<GitUpdateOptions>(snapshot.options);
  const [scopePreview, setScopePreview] = useState<GitUpdateScopePreview>(snapshot.scopePreview);
  const [previewDirty, setPreviewDirty] = useState<boolean>(false);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [scopeError, setScopeError] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setFormState(snapshot.options);
    setScopePreview(snapshot.scopePreview);
    setPreviewDirty(false);
    setPreviewLoading(false);
    setScopeError("");
  }, [open, snapshot]);

  const preview = useMemo(() => resolveMethodPreview(snapshot, formState, gt), [formState, snapshot, t]);
  const branchName = String(snapshot.methodResolution.currentBranch || "").trim();
  const sortedScopeRoots = useMemo(() => sortScopePreviewRoots(scopePreview.roots), [scopePreview.roots]);
  const linkedRepoCount = formState.scope.linkedRepoRoots.length;
  const includedScopeRootCount = scopePreview.includedRepoRoots.length;
  const updateMethodOptions = useMemo<GitUpdateMethodOptionItem[]>(() => ([
    {
      value: "merge",
      title: gt("dialogs.updateOptions.methods.merge.title", "合并"),
      description: gt("dialogs.updateOptions.methods.merge.description", "始终按合并方式更新当前分支。"),
    },
    {
      value: "rebase",
      title: gt("dialogs.updateOptions.methods.rebase.title", "变基"),
      description: gt("dialogs.updateOptions.methods.rebase.description", "始终按变基方式更新当前分支。"),
    },
  ]), [t]);
  const savePolicyOptions = useMemo<GitUpdateSavePolicyOptionItem[]>(() => ([
    {
      value: "stash",
      title: gt("dialogs.updateOptions.savePolicies.stash.title", "暂存（stash）"),
      description: gt("dialogs.updateOptions.savePolicies.stash.description", "使用暂存记录保存并恢复本地改动，并复用统一查看入口。"),
    },
    {
      value: "shelve",
      title: gt("dialogs.updateOptions.savePolicies.shelve.title", "搁置（shelve）"),
      description: gt("dialogs.updateOptions.savePolicies.shelve.description", "使用系统搁置记录保存并恢复本地改动，和手动搁置共用同一平台层。"),
    },
  ]), [t]);
  const syncStrategyOptions = useMemo<GitUpdateSyncStrategyOptionItem[]>(() => ([
    {
      value: "current",
      title: gt("dialogs.updateOptions.scope.syncStrategies.current.title", "仅当前仓库"),
      description: gt("dialogs.updateOptions.scope.syncStrategies.current.description", "默认只更新当前仓库与其子模块，不联动额外关联仓。"),
    },
    {
      value: "linked",
      title: gt("dialogs.updateOptions.scope.syncStrategies.linked.title", "联动关联仓"),
      description: gt("dialogs.updateOptions.scope.syncStrategies.linked.description", "把当前仓与已关联仓一起纳入更新项目，并允许按默认规则跳过部分仓。"),
    },
  ]), [t]);

  /**
   * 更新多仓默认范围草稿，并标记预览已过期，提醒用户按需重新检测。
   */
  const patchScope = (patch: Partial<GitUpdateScopeOptions>): void => {
    setFormState((prev) => updateScopeOptions(prev, patch));
    setPreviewDirty(true);
  };

  /**
   * 根据当前草稿重新向后端请求范围预览，确保子模块/嵌套仓结果与真实 Git 发现逻辑一致。
   */
  const refreshScopePreviewAsync = async (): Promise<void> => {
    if (!onRequestScopePreview) return;
    setPreviewLoading(true);
    setScopeError("");
    const nextPreview = await onRequestScopePreview(formState);
    setPreviewLoading(false);
    if (!nextPreview) {
      setScopeError(gt("dialogs.updateOptions.scope.preview.refreshFailed", "刷新多仓范围预览失败"));
      return;
    }
    setScopePreview(nextPreview);
    setPreviewDirty(false);
  };

  /**
   * 通过系统目录选择器添加新的关联仓根目录，供多仓联动默认策略复用。
   */
  const addLinkedRepoRootAsync = async (): Promise<void> => {
    const chooseRes = await window.host.utils.chooseFolder();
    if (!chooseRes?.ok || !chooseRes.path) {
      if (chooseRes?.canceled !== true && chooseRes?.error) {
        setScopeError(String(chooseRes.error || "").trim() || gt("dialogs.updateOptions.scope.linkedRepos.chooseFailed", "选择关联仓目录失败"));
      }
      return;
    }
    patchScope({
      linkedRepoRoots: [...formState.scope.linkedRepoRoots, chooseRes.path],
    });
  };

  /**
   * 移除指定关联仓，并同步清理其默认跳过规则，避免保留无效路径。
   */
  const removeLinkedRepoRoot = (repoRoot: string): void => {
    const repoKey = toRepoRootKey(repoRoot);
    patchScope({
      linkedRepoRoots: formState.scope.linkedRepoRoots.filter((item) => toRepoRootKey(item) !== repoKey),
      skippedRepoRoots: formState.scope.skippedRepoRoots.filter((item) => toRepoRootKey(item) !== repoKey),
    });
  };

  /**
   * 切换某个预览仓默认是否纳入 Update Project，并把结果写回跳过规则列表。
   */
  const toggleScopeRootInclusion = (repoRoot: string, nextIncluded: boolean): void => {
    const repoKey = toRepoRootKey(repoRoot);
    const skippedRepoRoots = nextIncluded
      ? formState.scope.skippedRepoRoots.filter((item) => toRepoRootKey(item) !== repoKey)
      : [...formState.scope.skippedRepoRoots, repoRoot];
    patchScope({ skippedRepoRoots });
    setScopePreview((prev) => ({
      ...prev,
      includedRepoRoots: nextIncluded
        ? dedupeRepoRoots([...prev.includedRepoRoots, repoRoot])
        : prev.includedRepoRoots.filter((item) => toRepoRootKey(item) !== repoKey),
      roots: prev.roots.map((item) => (toRepoRootKey(item.repoRoot) === repoKey ? { ...item, included: nextIncluded } : item)),
      skippedRoots: nextIncluded
        ? prev.skippedRoots.filter((item) => toRepoRootKey(item.repoRoot) !== repoKey)
        : [
          ...prev.skippedRoots.filter((item) => toRepoRootKey(item.repoRoot) !== repoKey),
          (() => {
            const matchedRoot = prev.roots.find((root) => toRepoRootKey(root.repoRoot) === repoKey);
            return {
              repoRoot,
              rootName: matchedRoot?.rootName || repoRoot,
              kind: matchedRoot?.kind || "repository",
              parentRepoRoot: matchedRoot?.parentRepoRoot,
              reasonCode: "requested" as const,
              reason: gt("dialogs.updateOptions.scope.preview.requestedSkipReason", "已按默认范围配置跳过该仓库"),
            };
          })(),
        ],
    }));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent className="max-w-[860px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0 text-[var(--cf-text-primary)]">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="text-base font-semibold">{gt("dialogs.updateOptions.title", "更新选项")}</DialogTitle>
          <DialogDescription className="text-xs text-[var(--cf-text-secondary)]">
            {gt("dialogs.updateOptions.description", "保存更新项目的默认更新方式、保留本地改动策略，以及多仓联动范围。")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[72vh] space-y-5 overflow-auto px-5 py-4">
          <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">{gt("dialogs.updateOptions.summary.currentRepository", "当前仓库")}</Badge>
              <span className="text-sm font-medium">
                {branchName
                  ? gt("dialogs.updateOptions.summary.branch", "分支 {{branch}}", { branch: branchName })
                  : gt("dialogs.updateOptions.summary.detached", "游离 HEAD / 待进入可更新分支")}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--cf-text-secondary)]">
              <span>{gt("dialogs.updateOptions.summary.executionPrefix", "当前若执行更新项目，将按")}</span>
              <Badge className="bg-[var(--cf-accent)] text-white">{getUpdateMethodLabel(preview.effectiveMethod, gt)}</Badge>
              <span>{gt("dialogs.updateOptions.summary.executionSuffix", "运行")}</span>
            </div>
            <div className="mt-2 text-xs text-[var(--cf-text-secondary)]">
              {gt("dialogs.updateOptions.summary.source", "来源：{{source}} · {{detail}}", {
                source: preview.sourceLabel,
                detail: preview.detailLabel,
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 text-sm font-medium">{gt("dialogs.updateOptions.sections.method", "更新方式")}</div>
            <div className="grid gap-3 md:grid-cols-2">
              {updateMethodOptions.map((option) => {
                const checked = formState.updateMethod === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "block cursor-pointer rounded-apple border px-3 py-3 transition-colors",
                      checked
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]"
                        : "border-[var(--cf-border)] bg-[var(--cf-surface-muted)] hover:bg-[var(--cf-surface-hover)]",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="cf-update-method"
                        className="mt-0.5 h-4 w-4"
                        checked={checked}
                        onChange={() => {
                          setFormState((prev) => ({
                            ...prev,
                            updateMethod: option.value,
                          }));
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{option.title}</div>
                        <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">{option.description}</div>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 text-sm font-medium">{gt("dialogs.updateOptions.sections.savePolicy", "保存本地改动策略")}</div>
            <div className="grid gap-3 md:grid-cols-2">
              {savePolicyOptions.map((option) => {
                const checked = formState.saveChangesPolicy === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "block cursor-pointer rounded-apple border px-3 py-3 transition-colors",
                      checked
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]"
                        : "border-[var(--cf-border)] bg-[var(--cf-surface-muted)] hover:bg-[var(--cf-surface-hover)]",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="cf-update-save-policy"
                        className="mt-0.5 h-4 w-4"
                        checked={checked}
                        onChange={() => {
                          setFormState((prev) => ({
                            ...prev,
                            saveChangesPolicy: option.value,
                          }));
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{option.title}</div>
                        <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">{option.description}</div>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="mt-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-2 text-xs text-[var(--cf-text-secondary)]">
              {gt("dialogs.updateOptions.savePolicyHint", "`stash` 会写入 Git 暂存记录；`shelve` 会写入统一系统搁置区。两者都会通过同一“查看已保存改动”入口继续恢复。")}
            </div>
          </section>

          <section className="space-y-4 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-4">
            <div>
              <div className="text-sm font-medium">{gt("dialogs.updateOptions.scope.title", "多仓默认范围")}</div>
              <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                {gt("dialogs.updateOptions.scope.summary", "当前默认会纳入 {{includedCount}} 个仓；已关联仓 {{linkedCount}} 个。", {
                  includedCount: includedScopeRootCount,
                  linkedCount: linkedRepoCount,
                })}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {syncStrategyOptions.map((option) => {
                const checked = formState.scope.syncStrategy === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "block cursor-pointer rounded-apple border px-3 py-3 transition-colors",
                      checked
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]"
                        : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:bg-[var(--cf-surface-hover)]",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="cf-update-sync-strategy"
                        className="mt-0.5 h-4 w-4"
                        checked={checked}
                        onChange={() => {
                          patchScope({ syncStrategy: option.value });
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{option.title}</div>
                        <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">{option.description}</div>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
              <label className="flex items-start gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={formState.scope.includeNestedRoots}
                  onChange={(event) => {
                    patchScope({ includeNestedRoots: event.target.checked });
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--cf-text-primary)]">{gt("dialogs.updateOptions.scope.includeNestedRoots.title", "额外扫描普通嵌套仓")}</span>
                  <span className="mt-1 block text-[var(--cf-text-secondary)]">
                    {gt("dialogs.updateOptions.scope.includeNestedRoots.description", "子模块始终会纳入依赖排序；开启后会继续扫描当前仓和关联仓下的普通嵌套 Git 仓库。")}
                  </span>
                </span>
              </label>
              <label className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3 text-xs">
                <div className="mb-1 text-[var(--cf-text-secondary)]">{gt("dialogs.updateOptions.scope.rootScanDepth", "扫描深度")}</div>
                <Input
                  type="number"
                  min={0}
                  max={12}
                  value={String(formState.scope.rootScanMaxDepth)}
                  onChange={(event) => {
                    const value = Math.max(0, Math.min(12, Math.floor(Number(event.target.value) || 0)));
                    patchScope({ rootScanMaxDepth: value });
                  }}
                  className="h-9 text-xs"
                />
              </label>
            </div>

            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{gt("dialogs.updateOptions.scope.linkedRepos.title", "关联仓列表")}</div>
                  <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                    {gt("dialogs.updateOptions.scope.linkedRepos.description", "这里维护“联动关联仓”模式默认会一起更新的独立仓根目录。")}
                  </div>
                </div>
                <Button size="xs" variant="secondary" className="gap-1" onClick={() => void addLinkedRepoRootAsync()}>
                  <FolderPlus className="h-3.5 w-3.5" />
                  {gt("dialogs.updateOptions.scope.linkedRepos.add", "添加仓库")}
                </Button>
              </div>
              <div className="mt-3 space-y-2">
                {formState.scope.linkedRepoRoots.length <= 0 ? (
                  <div className="rounded-apple border border-dashed border-[var(--cf-border)] px-3 py-3 text-xs text-[var(--cf-text-secondary)]">
                    {gt("dialogs.updateOptions.scope.linkedRepos.empty", "暂无关联仓。若要把多个独立仓作为默认 Update 范围，请先在这里添加。")}
                  </div>
                ) : formState.scope.linkedRepoRoots.map((repoRoot) => (
                  <div key={repoRoot} className="flex items-center justify-between gap-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{repoRoot.split(/[\\/]/).filter(Boolean).pop() || repoRoot}</div>
                      <div className="truncate text-[11px] text-[var(--cf-text-secondary)]">{repoRoot}</div>
                    </div>
                    <Button size="icon-sm" variant="ghost" title={gt("dialogs.updateOptions.scope.linkedRepos.remove", "移除关联仓")} onClick={() => { removeLinkedRepoRoot(repoRoot); }}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{gt("dialogs.updateOptions.scope.preview.title", "默认范围预览")}</div>
                  <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                    {gt("dialogs.updateOptions.scope.preview.description", "预览会按真实 repository graph、子模块和跳过规则计算，不是前端静态猜测。")}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  className="gap-1"
                  onClick={() => void refreshScopePreviewAsync()}
                  disabled={previewLoading || !onRequestScopePreview}
                >
                  {previewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {gt("dialogs.updateOptions.scope.preview.refresh", "刷新预览")}
                </Button>
              </div>
              {previewDirty ? (
                <div className="mt-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-accent-light)] px-3 py-2 text-xs text-[var(--cf-text-primary)]">
                  {gt("dialogs.updateOptions.scope.preview.dirtyHint", "预览基于上一次检测结果。修改关联仓、跳过规则或嵌套仓扫描设置后，建议刷新一次再保存。")}
                </div>
              ) : null}
              {scopeError ? (
                <div className="mt-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-red-light)] px-3 py-2 text-xs text-[var(--cf-red)]">
                  {scopeError}
                </div>
              ) : null}
              <div className="mt-3 space-y-2">
                {sortedScopeRoots.length <= 0 ? (
                  <div className="rounded-apple border border-dashed border-[var(--cf-border)] px-3 py-3 text-xs text-[var(--cf-text-secondary)]">
                    {gt("dialogs.updateOptions.scope.preview.empty", "当前没有可预览的仓库范围。")}
                  </div>
                ) : sortedScopeRoots.map((root) => {
                  const disabled = !canToggleScopeRoot(root);
                  return (
                    <label
                      key={root.repoRoot}
                      className={cn(
                        "flex items-start gap-3 rounded-apple border px-3 py-3 transition-colors",
                        root.included
                          ? "border-[var(--cf-border)] bg-[var(--cf-surface-muted)]"
                          : "border-[var(--cf-border)] bg-[var(--cf-surface)] opacity-85",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4"
                        checked={root.included}
                        disabled={disabled}
                        onChange={(event) => {
                          toggleScopeRootInclusion(root.repoRoot, event.target.checked);
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{root.rootName}</span>
                          <Badge variant="secondary" className="text-[10px]">{getScopeSourceLabel(root.source, gt)}</Badge>
                          <Badge variant="outline" className="text-[10px]">{root.kind === "submodule" ? gt("dialogs.updateScope.kind.submodule", "子模块") : gt("dialogs.updateScope.kind.repository", "仓库")}</Badge>
                          {root.detachedHead ? <Badge className="bg-[var(--cf-yellow-light)] text-[var(--cf-warning-foreground)]">{gt("dialogs.updateScope.detachedHead", "游离 HEAD")}</Badge> : null}
                          {!root.included ? <Badge className="bg-[var(--cf-red-light)] text-[var(--cf-red)]">{gt("dialogs.updateOptions.scope.preview.defaultSkipped", "默认跳过")}</Badge> : null}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-[var(--cf-text-secondary)]">{root.repoRoot}</div>
                        {root.parentRepoRoot ? (
                          <div className="mt-1 truncate text-[11px] text-[var(--cf-text-secondary)]">{gt("dialogs.updateOptions.scope.preview.parentRepository", "父仓：{{path}}", { path: root.parentRepoRoot })}</div>
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-4">
          <Button size="xs" variant="secondary" onClick={onClose} disabled={submitting}>
            {gt("dialogs.updateOptions.cancel", "取消")}
          </Button>
          <Button size="xs" onClick={() => onConfirm(formState)} disabled={submitting}>
            {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            {gt("dialogs.updateOptions.save", "保存")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
