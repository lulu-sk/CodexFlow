// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Loader2, RefreshCcw } from "lucide-react";
import { resolveGitTextWith } from "./git-i18n";
import type { GitPullCapabilities, GitPullOptionKey } from "./types";

type GitPullDialogOptionKey = Exclude<GitPullOptionKey, "rebase">;
type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

export type GitPullDialogValue = {
  repoRoot: string;
  remote: string;
  branch: string;
  mode: "merge" | "rebase";
  options: GitPullDialogOptionKey[];
};

export type GitPullDialogRepositoryOption = {
  repoRoot: string;
  label: string;
  currentBranchName?: string;
  remotes: GitPullDialogRemoteOption[];
};

export type GitPullDialogRemoteOption = {
  name: string;
  branches: string[];
};

type GitPullDialogProps = {
  open: boolean;
  repositories: GitPullDialogRepositoryOption[];
  value: GitPullDialogValue;
  capabilities: GitPullCapabilities;
  submitting: boolean;
  refreshing: boolean;
  onClose(): void;
  onChange(nextValue: GitPullDialogValue): void;
  onRefresh(next: { repoRoot: string; remote: string }): void;
  onSubmit(): void;
};

/**
 * 返回当前选中的仓库配置，供多 root Pull 对话框联动仓库、远端与分支选择。
 */
function resolveSelectedRepository(
  repositories: GitPullDialogRepositoryOption[],
  repoRoot: string,
): GitPullDialogRepositoryOption | null {
  return repositories.find((repository) => repository.repoRoot === repoRoot) || null;
}

/**
 * 返回当前选中的远端信息，供对话框统一渲染命令行与分支列表。
 */
function resolveSelectedRemote(
  remotes: GitPullDialogRemoteOption[],
  remoteName: string,
): GitPullDialogRemoteOption | null {
  return remotes.find((remote) => remote.name === remoteName) || null;
}

const GIT_PULL_OPTION_ORDER: GitPullDialogOptionKey[] = ["ffOnly", "noFf", "squash", "noCommit", "noVerify"];

const GIT_PULL_OPTION_FLAGS: Record<GitPullDialogOptionKey, string> = {
  ffOnly: "--ff-only",
  noFf: "--no-ff",
  squash: "--squash",
  noCommit: "--no-commit",
  noVerify: "--no-verify",
};

/**
 * 基于当前语言构建 Pull 附加选项的展示文案，统一给选项卡片与说明区复用。
 */
function buildPullOptionMeta(gt: GitTranslate): Record<GitPullDialogOptionKey, { flag: string; label: string; description: string }> {
  return {
    ffOnly: {
      flag: GIT_PULL_OPTION_FLAGS.ffOnly,
      label: gt("dialogs.pull.options.ffOnly.label", "仅快进"),
      description: gt("dialogs.pull.options.ffOnly.description", "只允许 fast-forward；若需要 merge commit 则直接失败。"),
    },
    noFf: {
      flag: GIT_PULL_OPTION_FLAGS.noFf,
      label: gt("dialogs.pull.options.noFf.label", "禁止快进"),
      description: gt("dialogs.pull.options.noFf.description", "即使可快进也保留 merge commit，显式记录这次拉取。"),
    },
    squash: {
      flag: GIT_PULL_OPTION_FLAGS.squash,
      label: gt("dialogs.pull.options.squash.label", "Squash"),
      description: gt("dialogs.pull.options.squash.description", "把远端变更压成工作区改动，不立即生成 merge commit。"),
    },
    noCommit: {
      flag: GIT_PULL_OPTION_FLAGS.noCommit,
      label: gt("dialogs.pull.options.noCommit.label", "不自动提交"),
      description: gt("dialogs.pull.options.noCommit.description", "完成 merge 后停在暂存区，由你手动确认提交内容。"),
    },
    noVerify: {
      flag: GIT_PULL_OPTION_FLAGS.noVerify,
      label: gt("dialogs.pull.options.noVerify.label", "跳过 Hooks"),
      description: gt("dialogs.pull.options.noVerify.description", "跳过 pre-merge / pre-rebase 钩子；仅在当前 Git 支持时可用。"),
    },
  };
}

/**
 * 判断候选 Pull 选项是否与当前模式及已选项兼容，规则对齐 IDEA `GitPullOption.isOptionSuitable()`。
 */
function resolvePullOptionAvailability(
  mode: GitPullDialogValue["mode"],
  selectedOptions: GitPullDialogOptionKey[],
  option: GitPullDialogOptionKey,
  capabilities: GitPullCapabilities,
  gt: GitTranslate,
): { enabled: boolean; reason?: string } {
  if (option === "noVerify" && capabilities.noVerify !== true) {
    return {
      enabled: false,
      reason: gt("dialogs.pull.options.noVerify.unsupported", "当前 Git 不支持 `git pull --no-verify`。"),
    };
  }
  if (mode === "rebase" && option !== "noVerify") {
    return {
      enabled: false,
      reason: gt("dialogs.pull.options.mergeOnly", "Rebase 模式下不支持该合并选项。"),
    };
  }
  const selected = new Set(selectedOptions);
  if (option === "ffOnly" && (selected.has("noFf") || selected.has("squash"))) {
    return { enabled: false, reason: gt("dialogs.pull.options.ffOnly.conflict", "与 `--no-ff`、`--squash` 互斥。") };
  }
  if (option === "noFf" && (selected.has("ffOnly") || selected.has("squash"))) {
    return { enabled: false, reason: gt("dialogs.pull.options.noFf.conflict", "与 `--ff-only`、`--squash` 互斥。") };
  }
  if (option === "squash" && (selected.has("ffOnly") || selected.has("noFf"))) {
    return { enabled: false, reason: gt("dialogs.pull.options.squash.conflict", "与 `--ff-only`、`--no-ff` 互斥。") };
  }
  return { enabled: true };
}

/**
 * 规整 Pull 选项集合，统一去重、排序并清理与当前模式冲突的项。
 */
function normalizePullDialogOptions(
  mode: GitPullDialogValue["mode"],
  options: GitPullDialogOptionKey[],
  capabilities: GitPullCapabilities,
  gt: GitTranslate,
): GitPullDialogOptionKey[] {
  const accepted: GitPullDialogOptionKey[] = [];
  for (const option of GIT_PULL_OPTION_ORDER) {
    if (!options.includes(option)) continue;
    const availability = resolvePullOptionAvailability(mode, accepted, option, capabilities, gt);
    if (!availability.enabled) continue;
    accepted.push(option);
  }
  return accepted;
}

/**
 * 将 Pull 策略映射为界面展示文案，保持主次信息层级稳定。
 */
function getPullModeMeta(mode: GitPullDialogValue["mode"], gt: GitTranslate): { label: string; description: string } {
  if (mode === "rebase") {
    return {
      label: gt("dialogs.pull.modes.rebase.label", "Rebase"),
      description: gt("dialogs.pull.modes.rebase.description", "先获取远端，再将本地提交重放到最新远端之上。"),
    };
  }
  return {
    label: gt("dialogs.pull.modes.merge.label", "Merge"),
    description: gt("dialogs.pull.modes.merge.description", "保持现有历史，直接把远端变更合并到当前分支。"),
  };
}

/**
 * 生成 Pull 对话框标题；有当前分支时对齐 IDEA 的“拉取到 <branch>”语义。
 */
function buildPullDialogTitle(currentBranchName: string | undefined, gt: GitTranslate): string {
  const branchName = String(currentBranchName || "").trim();
  return branchName
    ? gt("dialogs.pull.titleWithBranch", "拉取到 {{branch}}", { branch: branchName })
    : gt("dialogs.pull.title", "拉取");
}

/**
 * 渲染独立 Pull 对话框，采用更接近 IDEA 的命令式布局与层级。
 */
export function PullDialog(props: GitPullDialogProps): JSX.Element | null {
  const { t } = useTranslation(["git", "common"]);
  const {
    open,
    repositories,
    value,
    capabilities,
    submitting,
    refreshing,
    onClose,
    onChange,
    onRefresh,
    onSubmit,
  } = props;

  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);
  if (!open) return null;

  const selectedRepository = resolveSelectedRepository(repositories, value.repoRoot);
  const remotes = selectedRepository?.remotes || [];
  const selectedRemote = resolveSelectedRemote(remotes, value.remote);
  const availableBranches = selectedRemote?.branches || [];
  const canSubmit = !!value.repoRoot && !!selectedRemote && !!value.branch;
  const pullOptionMeta = buildPullOptionMeta(gt);
  const normalizedOptions = normalizePullDialogOptions(value.mode, value.options, capabilities, gt);
  const dialogTitle = buildPullDialogTitle(selectedRepository?.currentBranchName, gt);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent className="cf-git-dialog-panel w-[620px] max-w-[calc(100vw-2.5rem)] overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="text-base">{dialogTitle}</DialogTitle>
          <DialogDescription>{gt("dialogs.pull.description", "选择远端与分支，执行独立 Pull。")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 py-4">
          {repositories.length > 1 ? (
            <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-2.5">
              <div className="text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                {gt("dialogs.pull.repositoryRoot", "仓库 Root")}
              </div>
              <Select
                value={value.repoRoot}
                onValueChange={(nextRepoRoot) => {
                  const nextRepository = resolveSelectedRepository(repositories, nextRepoRoot);
                  const nextRemote = nextRepository?.remotes[0] || null;
                  onChange({
                    ...value,
                    repoRoot: nextRepoRoot,
                    remote: nextRemote?.name || "",
                    branch: nextRemote?.branches[0] || "",
                    options: normalizedOptions,
                  });
                }}
              >
                <SelectTrigger className="mt-1 cf-git-filter-input h-8 bg-[var(--cf-surface)] px-2 text-xs">
                  <SelectValue placeholder={gt("dialogs.pull.selectRepository", "请选择仓库")} />
                </SelectTrigger>
                <SelectContent fitContent maxContentWidth={360}>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.repoRoot} value={repository.repoRoot}>
                      {repository.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          ) : null}

          <section
            data-testid="git-pull-command-strip"
            className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3.5"
          >
            <div className="grid grid-cols-[auto,minmax(0,1fr),minmax(0,1.15fr),auto] items-end gap-x-2.5 gap-y-1.5">
              <span aria-hidden="true" />
              <div className="text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                {gt("dialogs.pull.remote", "远端")}
              </div>
              <div className="text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                {gt("dialogs.pull.branch", "分支")}
              </div>
              <span aria-hidden="true" />
              <div className="flex h-8 shrink-0 items-center rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2.5 font-mono text-[11px] text-[var(--cf-text-secondary)]">
                git pull
              </div>
              <Select
                value={value.remote}
                onValueChange={(nextRemote) => {
                  const nextRemoteInfo = resolveSelectedRemote(remotes, nextRemote);
                  const nextBranches = nextRemoteInfo?.branches || [];
                  onChange({
                    ...value,
                    remote: nextRemote,
                    branch: nextBranches.includes(value.branch) ? value.branch : (nextBranches[0] || ""),
                    options: normalizedOptions,
                  });
                }}
              >
                <SelectTrigger className="cf-git-filter-input h-8 min-w-[150px] bg-[var(--cf-surface)] px-2 text-xs">
                  <SelectValue placeholder={gt("dialogs.pull.selectRemote", "请选择远端")} />
                </SelectTrigger>
                <SelectContent fitContent maxContentWidth={320}>
                  {remotes.map((remote) => (
                    <SelectItem key={remote.name} value={remote.name}>
                      {remote.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={value.branch}
                onValueChange={(nextBranch) => {
                  onChange({
                    ...value,
                    branch: nextBranch,
                  });
                }}
              >
                <SelectTrigger className="cf-git-filter-input h-8 min-w-[220px] bg-[var(--cf-surface)] px-2 text-xs">
                  <SelectValue placeholder={selectedRemote ? gt("dialogs.pull.selectBranch", "请选择远端分支") : gt("dialogs.pull.selectRemoteFirst", "请先选择远端")} />
                </SelectTrigger>
                <SelectContent fitContent maxContentWidth={420}>
                  {availableBranches.map((branch) => (
                    <SelectItem key={branch} value={branch}>
                      {branch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-8 w-8 shrink-0 self-end"
                disabled={submitting || refreshing || !selectedRemote}
                aria-label={gt("dialogs.pull.refreshBranchesAria", "获取远端分支列表")}
                title={selectedRemote
                  ? gt("dialogs.pull.refreshBranches", "获取 {{remote}} 的最新分支", { remote: selectedRemote.name })
                  : gt("dialogs.pull.refreshBranchesDisabled", "请选择远端后再获取")}
                onClick={() => {
                  onRefresh({
                    repoRoot: value.repoRoot,
                    remote: value.remote,
                  });
                }}
              >
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </section>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--cf-border)] px-5 py-3.5">
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button
                data-testid="git-pull-options-trigger"
                size="xs"
                variant="ghost"
                className="h-auto px-0 text-[12px] text-[var(--cf-accent)] hover:bg-transparent"
              >
                {gt("dialogs.pull.modifyOptions", "修改选项")}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[340px] p-0">
              <div className="space-y-3 p-3">
                <section>
                  <div className="mb-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                    {gt("dialogs.pull.strategy", "拉取策略")}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(["merge", "rebase"] as const).map((mode) => {
                      const meta = getPullModeMeta(mode, gt);
                      const selected = value.mode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          className={cn(
                            "rounded-apple border px-3 py-2.5 text-left transition-colors",
                            selected
                              ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]"
                              : "border-[var(--cf-border)] bg-[var(--cf-surface-solid)] hover:bg-[var(--cf-surface-hover)]",
                          )}
                          onClick={() => {
                            onChange({
                              ...value,
                              mode,
                              options: normalizePullDialogOptions(mode, value.options, capabilities, gt),
                            });
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium text-[var(--cf-text-primary)]">{meta.label}</span>
                            {selected ? <Check className="h-4 w-4 text-[var(--cf-accent)]" /> : null}
                          </div>
                          <div className="mt-1 text-[11px] leading-[1.45] text-[var(--cf-text-secondary)]">{meta.description}</div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <div className="mb-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                    {gt("dialogs.pull.extraOptions", "附加选项")}
                  </div>
                  <div className="space-y-1.5">
                    {GIT_PULL_OPTION_ORDER.map((option) => {
                      const meta = pullOptionMeta[option];
                      const selected = normalizedOptions.includes(option);
                      const availability = resolvePullOptionAvailability(value.mode, normalizedOptions, option, capabilities, gt);
                      const disabled = !availability.enabled && !selected;
                      return (
                        <button
                          key={option}
                          type="button"
                          disabled={disabled}
                          title={availability.reason}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-apple border px-3 py-2 text-left transition-colors",
                            selected
                              ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]"
                              : "border-[var(--cf-border)] bg-[var(--cf-surface-solid)]",
                            disabled ? "cursor-not-allowed opacity-55" : "hover:bg-[var(--cf-surface-hover)]",
                          )}
                          onClick={() => {
                            const nextOptions = selected
                              ? normalizedOptions.filter((item) => item !== option)
                              : [...normalizedOptions, option];
                            onChange({
                              ...value,
                              options: normalizePullDialogOptions(value.mode, nextOptions, capabilities, gt),
                            });
                          }}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                              selected
                                ? "border-[var(--cf-accent)] bg-[var(--cf-accent)] text-white"
                                : "border-[var(--cf-border)] bg-[var(--cf-surface)]",
                            )}
                          >
                            {selected ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium text-[var(--cf-text-primary)]">{meta.label}</span>
                              <span className="font-mono text-[10px] text-[var(--cf-text-secondary)]">{meta.flag}</span>
                            </span>
                            <span className="mt-1 block text-[10px] leading-[1.45] text-[var(--cf-text-secondary)]">
                              {disabled && availability.reason ? availability.reason : meta.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-2">
            <Button data-testid="git-pull-cancel" size="xs" variant="secondary" disabled={submitting} onClick={onClose}>
              {gt("dialogs.pull.cancel", "取消")}
            </Button>
            <Button data-testid="git-pull-submit" size="xs" disabled={!canSubmit || submitting} onClick={onSubmit}>
              {submitting ? gt("dialogs.pull.submitting", "拉取中...") : gt("dialogs.pull.submit", "拉取")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
