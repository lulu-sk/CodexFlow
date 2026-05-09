// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { resolveGitTextWith } from "./git-i18n";

export type GitFetchDialogTagMode = "auto" | "all" | "none";

export type GitFetchDialogMode =
  | "default-remote"
  | "specific-remote"
  | "all-remotes";

export type GitFetchDialogRepositoryOption = {
  repoRoot: string;
  label: string;
  remotes: Array<{
    name: string;
    fetchUrl?: string;
  }>;
  defaultRemote?: string;
};

export type GitFetchDialogValue = {
  repoRoot: string;
  mode: GitFetchDialogMode;
  remote: string;
  refspec: string;
  unshallow: boolean;
  tagMode: GitFetchDialogTagMode;
};

type GitFetchDialogProps = {
  open: boolean;
  repositories: GitFetchDialogRepositoryOption[];
  value: GitFetchDialogValue;
  submitting: boolean;
  onClose(): void;
  onChange(nextValue: GitFetchDialogValue): void;
  onSubmit(): void;
};

/**
 * 定位当前 fetch 对话框选中的仓库配置，供远端列表与默认值联动复用。
 */
function resolveSelectedRepository(
  repositories: GitFetchDialogRepositoryOption[],
  repoRoot: string,
): GitFetchDialogRepositoryOption | null {
  return repositories.find((repository) => repository.repoRoot === repoRoot) || null;
}

/**
 * 按当前模式生成 fetch 命令预览，统一覆盖 default/specific/all 三种入口。
 */
function buildFetchCommandPreview(
  value: GitFetchDialogValue,
  repository: GitFetchDialogRepositoryOption | null,
): string {
  const segments = ["git", "fetch"];
  if (value.mode === "all-remotes") segments.push("--all");
  else if (value.mode === "specific-remote" && value.remote) segments.push(value.remote);
  else if (value.mode === "default-remote" && repository?.defaultRemote) segments.push(repository.defaultRemote);
  if (value.unshallow) segments.push("--unshallow");
  if (value.tagMode === "all") segments.push("--tags");
  else if (value.tagMode === "none") segments.push("--no-tags");
  if (value.refspec) segments.push(value.refspec);
  return segments.join(" ");
}

/**
 * 判断当前 fetch 对话框是否具备提交条件，避免缺失仓库或远端时误触发后台流程。
 */
function canSubmitFetchDialog(
  value: GitFetchDialogValue,
  repository: GitFetchDialogRepositoryOption | null,
): boolean {
  if (!value.repoRoot || !repository) return false;
  if (value.mode !== "specific-remote") return true;
  return !!String(value.remote || "").trim();
}

/**
 * 渲染显式 fetch 参数对话框，统一承载多 root、远端策略、refspec 与 tag mode 选择。
 */
export function FetchDialog(props: GitFetchDialogProps): JSX.Element | null {
  const { t } = useTranslation(["git", "common"]);
  const {
    open,
    repositories,
    value,
    submitting,
    onClose,
    onChange,
    onSubmit,
  } = props;
  if (!open) return null;

  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);

  const selectedRepository = resolveSelectedRepository(repositories, value.repoRoot);
  const selectedRemote = String(value.remote || "").trim();
  const commandPreview = buildFetchCommandPreview(value, selectedRepository);
  const canSubmit = canSubmitFetchDialog(value, selectedRepository);
  const hasMultipleRepositories = repositories.length > 1;
  const fetchModeItems = [
    {
      value: "default-remote" as const,
      label: gt("dialogs.fetch.scope.defaultRemote.label", "默认远端"),
      description: gt("dialogs.fetch.scope.defaultRemote.description", "对齐原生 `git fetch`，优先当前分支上游，其次 origin。"),
    },
    {
      value: "specific-remote" as const,
      label: gt("dialogs.fetch.scope.specificRemote.label", "指定远端"),
      description: gt("dialogs.fetch.scope.specificRemote.description", "显式选择某个远端；适合多远端仓库做定向 fetch。"),
    },
    {
      value: "all-remotes" as const,
      label: gt("dialogs.fetch.scope.allRemotes.label", "全部远端"),
      description: gt("dialogs.fetch.scope.allRemotes.description", "顺序获取当前仓库配置的全部远端。"),
    },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent className="cf-git-dialog-panel w-[760px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="text-base">{gt("dialogs.fetch.title", "获取远端变更")}</DialogTitle>
          <DialogDescription>{gt("dialogs.fetch.description", "显式选择目标仓库、远端范围与附加参数，避免 fetch 退化为单一默认动作。")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 py-4">
          <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
            <div className="mb-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
              {gt("dialogs.fetch.targetRepository", "目标仓库")}
            </div>
            {hasMultipleRepositories ? (
              <Select
                value={value.repoRoot}
                onValueChange={(nextRepoRoot) => {
                  const nextRepository = resolveSelectedRepository(repositories, nextRepoRoot);
                  onChange({
                    ...value,
                    repoRoot: nextRepoRoot,
                    remote: nextRepository?.defaultRemote || nextRepository?.remotes[0]?.name || "",
                  });
                }}
              >
                <SelectTrigger className="cf-git-filter-input h-9 bg-[var(--cf-surface)] px-2 text-xs">
                  <SelectValue placeholder={gt("dialogs.fetch.selectRepository", "请选择仓库")} />
                </SelectTrigger>
                <SelectContent fitContent maxContentWidth={420}>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.repoRoot} value={repository.repoRoot}>
                      {repository.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <code className="block break-all text-[11px] text-[var(--cf-text-primary)]">
                {selectedRepository?.repoRoot || gt("dialogs.fetch.repositoryUnavailable", "当前仓库不可用")}
              </code>
            )}
          </section>

          <section className="grid gap-3 lg:grid-cols-[1.15fr,1fr]">
            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
              <div className="mb-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                {gt("dialogs.fetch.scope.title", "获取范围")}
              </div>
              <div className="space-y-2">
                {fetchModeItems.map((item) => {
                  const selected = value.mode === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={`w-full rounded-apple border px-3 py-2 text-left transition ${
                        selected
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                          : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-accent)]/40"
                      }`}
                      onClick={() => {
                        onChange({
                          ...value,
                          mode: item.value,
                          remote: item.value === "specific-remote"
                            ? (selectedRemote || selectedRepository?.defaultRemote || selectedRepository?.remotes[0]?.name || "")
                            : value.remote,
                        });
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-[var(--cf-text-primary)]">{item.label}</span>
                        {selected ? <Badge variant="secondary" className="text-[10px]">{gt("dialogs.fetch.scope.selected", "已选")}</Badge> : null}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">{item.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
              <div className="mb-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                {gt("dialogs.fetch.extraOptions", "附加参数")}
              </div>
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="text-xs text-[var(--cf-text-secondary)]">{gt("dialogs.fetch.remote", "远端")}</div>
                  <Select
                    value={selectedRemote}
                    onValueChange={(nextRemote) => {
                      if (value.mode !== "specific-remote") return;
                      onChange({
                        ...value,
                        remote: nextRemote,
                      });
                    }}
                  >
                    <SelectTrigger
                      className="cf-git-filter-input h-9 bg-[var(--cf-surface)] px-2 text-xs"
                      disabled={value.mode !== "specific-remote"}
                    >
                      <SelectValue placeholder={gt("dialogs.fetch.selectRemote", "请选择远端")} />
                    </SelectTrigger>
                    <SelectContent fitContent maxContentWidth={360}>
                      {(selectedRepository?.remotes || []).map((remote) => (
                        <SelectItem key={remote.name} value={remote.name}>
                          {remote.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {value.mode !== "specific-remote" ? (
                    <div className="text-[10px] text-[var(--cf-text-secondary)]">{gt("dialogs.fetch.remoteHint", "仅在“指定远端”模式下生效。")}</div>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-[var(--cf-text-secondary)]">{gt("dialogs.fetch.tagMode", "标签策略")}</div>
                  <Select
                    value={value.tagMode}
                    onValueChange={(nextValue) => {
                      onChange({
                        ...value,
                        tagMode: nextValue as GitFetchDialogTagMode,
                      });
                    }}
                  >
                    <SelectTrigger className="cf-git-filter-input h-9 bg-[var(--cf-surface)] px-2 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent fitContent maxContentWidth={300}>
                      <SelectItem value="auto">{gt("dialogs.fetch.tagModeOptions.auto", "默认")}</SelectItem>
                      <SelectItem value="all">{gt("dialogs.fetch.tagModeOptions.all", "获取全部标签")}</SelectItem>
                      <SelectItem value="none">{gt("dialogs.fetch.tagModeOptions.none", "跳过标签")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-[var(--cf-text-secondary)]">{gt("dialogs.fetch.refspec", "引用规格")}</div>
                  <Input
                    value={value.refspec}
                    onChange={(event) => {
                      onChange({
                        ...value,
                        refspec: event.target.value,
                      });
                    }}
                    placeholder={gt("dialogs.fetch.refspecPlaceholder", "可选，例如 refs/heads/main:refs/remotes/origin/main")}
                    className="cf-git-filter-input h-9 bg-[var(--cf-surface)] px-2 text-xs"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-[var(--cf-text-primary)]">
                  <input
                    type="checkbox"
                    checked={value.unshallow}
                    onChange={(event) => {
                      onChange({
                        ...value,
                        unshallow: event.target.checked,
                      });
                    }}
                  />
                  {gt("dialogs.fetch.unshallow", "将浅克隆仓库补全为完整历史（`--unshallow`）")}
                </label>
              </div>
            </div>
          </section>

          <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
            <div className="mb-1 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
              {gt("dialogs.fetch.commandPreview", "命令预览")}
            </div>
            <code className="block break-all text-[11px] text-[var(--cf-text-primary)]">{commandPreview}</code>
          </section>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--cf-border)] px-5 py-3">
          <div className="text-[10px] text-[var(--cf-text-secondary)]">
            {selectedRepository?.remotes.length
              ? gt("dialogs.fetch.remotesSummary", "当前仓库远端：{{names}}", {
                names: selectedRepository.remotes.map((remote) => remote.name).join(gt("dialogs.fetch.listSeparator", "、")),
              })
              : gt("dialogs.fetch.noRemotes", "当前仓库尚未配置远端")}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              {gt("dialogs.fetch.cancel", "取消")}
            </Button>
            <Button onClick={onSubmit} disabled={!canSubmit || submitting}>
              {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {gt("dialogs.fetch.submit", "开始获取")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
