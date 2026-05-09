import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, GitBranch, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { resolveGitTextWith, resolveGitUpdateMethodLabel } from "../git-i18n";
import type {
  GitUpdateOptionMethod,
  GitUpdateTrackedBranchIssue,
  GitUpdateTrackedBranchPreview,
  GitUpdateTrackedBranchSelection,
} from "./types";

type FixTrackedBranchDialogProps = {
  open: boolean;
  preview: GitUpdateTrackedBranchPreview | null;
  submitting: boolean;
  continueMode?: "update" | "reset";
  onClose(): void;
  onConfirm(payload: { selections: GitUpdateTrackedBranchSelection[]; updateMethod: GitUpdateOptionMethod }): void;
};

type GitUpdateTrackedBranchFormItem = {
  remote: string;
  remoteBranch: string;
  setAsTracked: boolean;
};

/**
 * 根据问题项生成对话框初始表单值。
 */
function buildInitialFormState(preview: GitUpdateTrackedBranchPreview | null): Record<string, GitUpdateTrackedBranchFormItem> {
  const next: Record<string, GitUpdateTrackedBranchFormItem> = {};
  for (const issue of preview?.issues || []) {
    next[issue.repoRoot] = {
      remote: String(issue.suggestedRemote || issue.currentRemote || issue.remoteOptions[0]?.name || "").trim(),
      remoteBranch: String(issue.suggestedRemoteBranch || issue.currentRemoteBranch || issue.remoteOptions[0]?.branches[0] || "").trim(),
      setAsTracked: issue.issueCode === "no-tracked-branch",
    };
  }
  return next;
}

/**
 * 读取指定远端下的远端分支候选列表。
 */
function getRemoteBranches(issue: GitUpdateTrackedBranchIssue, remote: string): string[] {
  const remoteName = String(remote || "").trim();
  if (!remoteName) return [];
  return issue.remoteOptions.find((one) => one.name === remoteName)?.branches || [];
}

/**
 * 把 tracked branch 问题码转换为更直接的标题。
 */
function getIssueTitle(
  issue: GitUpdateTrackedBranchIssue,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : fallback;
  };
  if (issue.issueCode === "remote-missing") return resolveLabel("dialogs.fixTrackedBranch.issueTitles.remoteMissing", "上游分支失效");
  return resolveLabel("dialogs.fixTrackedBranch.issueTitles.noTrackedBranch", "缺少上游分支");
}

/**
 * 把 tracked branch 问题映射为可翻译说明，避免对话框直接显示主进程拼接文案。
 */
function getIssueMessage(
  issue: GitUpdateTrackedBranchIssue,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveText ? resolveText(key, fallback, values) : fallback;
  };
  if (issue.issueCode === "remote-missing") {
    const fallbackUpstream = issue.suggestedRemote && issue.suggestedRemoteBranch
      ? `${issue.suggestedRemote}/${issue.suggestedRemoteBranch}`
      : "";
    return resolveLabel("dialogs.fixTrackedBranch.messages.remoteMissing", "当前上游分支 {{upstream}} 在本地不存在或已失效。", {
      upstream: issue.currentUpstream || fallbackUpstream || "HEAD",
    });
  }
  return resolveLabel("dialogs.fixTrackedBranch.messages.noTrackedBranch", "当前分支 {{branch}} 未配置远端上游分支。", {
    branch: issue.branch || "HEAD",
  });
}

/**
 * 把继续更新方式转换为界面短标签。
 */
function getUpdateMethodLabel(
  method: GitUpdateOptionMethod,
  resolveText?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string {
  return resolveGitUpdateMethodLabel(method, resolveText) || "合并";
}

/**
 * 渲染 tracked branch 修复对话框，仅承载 IDEA 主路径的 upstream 修复与 Merge/Rebase 选择。
 */
export function FixTrackedBranchDialog(props: FixTrackedBranchDialogProps): JSX.Element | null {
  const { t } = useTranslation("git");
  const gt = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const { open, preview, submitting, continueMode = "update", onClose, onConfirm } = props;
  const [formState, setFormState] = useState<Record<string, GitUpdateTrackedBranchFormItem>>({});
  const [updateMethod, setUpdateMethod] = useState<GitUpdateOptionMethod>("merge");

  useEffect(() => {
    if (!open) return;
    setFormState(buildInitialFormState(preview));
    setUpdateMethod(preview?.defaultUpdateMethod || "merge");
  }, [open, preview]);

  const validSelections = useMemo(() => {
    const issues = preview?.issues || [];
    return issues
      .filter((issue) => issue.canFix)
      .map((issue) => {
        const form = formState[issue.repoRoot];
        const remote = String(form?.remote || "").trim();
        const remoteBranch = String(form?.remoteBranch || "").trim();
        if (!remote || !remoteBranch) return null;
        return {
          repoRoot: issue.repoRoot,
          remote,
          remoteBranch,
          setAsTracked: form?.setAsTracked === true,
        } satisfies GitUpdateTrackedBranchSelection;
      })
      .filter(Boolean) as GitUpdateTrackedBranchSelection[];
  }, [formState, preview]);

  if (!preview) return null;

  const fixableIssueCount = preview.issues.filter((issue) => issue.canFix).length;
  const hasFixableIssues = fixableIssueCount > 0;
  const canConfirm = hasFixableIssues && validSelections.length === fixableIssueCount;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogContent className="cf-git-dialog-panel w-[760px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4" />
            {gt("dialogs.fixTrackedBranch.title", "修复跟踪分支后继续更新")}
          </DialogTitle>
          <DialogDescription>
            {preview.multiRoot
              ? gt("dialogs.fixTrackedBranch.description.multiRoot", "检测到部分仓库缺少可用的上游分支，请逐仓确认后继续更新项目。")
              : gt("dialogs.fixTrackedBranch.description.singleRoot", "当前分支缺少可用的上游分支，请确认远端分支后继续更新项目。")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-auto px-5 py-4">
          {preview.issues.length <= 0 ? (
            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3 text-xs text-[var(--cf-text-secondary)]">
              {gt("dialogs.fixTrackedBranch.empty", "当前没有需要修复的跟踪分支问题。")}
            </div>
          ) : null}
          {preview.issues.map((issue) => {
            const form = formState[issue.repoRoot] || {
              remote: "",
              remoteBranch: "",
              setAsTracked: false,
            };
            const branches = getRemoteBranches(issue, form.remote);
            return (
              <div key={issue.repoRoot} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <AlertTriangle className="h-4 w-4 text-[var(--cf-orange)]" />
                      <span className="truncate">{issue.rootName}</span>
                      <span className="rounded-apple-sm border border-[var(--cf-border)] px-2 py-0.5 text-[10px] text-[var(--cf-text-secondary)]">
                        {issue.kind === "submodule"
                          ? gt("dialogs.updateScope.kind.submodule", "子模块")
                          : gt("dialogs.updateScope.kind.repository", "仓库")}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">{getIssueTitle(issue, gt)}</div>
                    <div className="mt-2 text-xs text-[var(--cf-text-primary)]">{getIssueMessage(issue, gt)}</div>
                    {issue.branch ? <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">{gt("dialogs.fixTrackedBranch.labels.localBranch", "本地分支：{{branch}}", { branch: issue.branch })}</div> : null}
                    {issue.currentUpstream ? <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">{gt("dialogs.fixTrackedBranch.labels.currentUpstream", "当前上游：{{branch}}", { branch: issue.currentUpstream })}</div> : null}
                  </div>
                </div>
                {issue.canFix ? (
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <label className="block text-xs">
                      <div className="mb-1 text-[var(--cf-text-secondary)]">{gt("dialogs.fixTrackedBranch.labels.remote", "远端")}</div>
                      <Select
                        value={form.remote}
                        onValueChange={(nextRemote) => {
                          const nextBranches = getRemoteBranches(issue, nextRemote);
                          setFormState((prev) => ({
                            ...prev,
                            [issue.repoRoot]: {
                              ...prev[issue.repoRoot],
                              remote: nextRemote,
                              remoteBranch: nextBranches.includes(prev[issue.repoRoot]?.remoteBranch || "")
                                ? String(prev[issue.repoRoot]?.remoteBranch || "").trim()
                                : String(nextBranches[0] || "").trim(),
                            },
                          }));
                        }}
                      >
                        <SelectTrigger className="cf-git-filter-input h-9 text-xs">
                          <SelectValue placeholder={gt("dialogs.fixTrackedBranch.placeholders.remote", "选择远端")} />
                        </SelectTrigger>
                        <SelectContent>
                          {issue.remoteOptions.map((option) => (
                            <SelectItem key={`${issue.repoRoot}:remote:${option.name}`} value={option.name}>
                              {option.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="block text-xs">
                      <div className="mb-1 text-[var(--cf-text-secondary)]">{gt("dialogs.fixTrackedBranch.labels.remoteBranch", "远端分支")}</div>
                      <Select
                        value={form.remoteBranch}
                        onValueChange={(nextBranch) => {
                          setFormState((prev) => ({
                            ...prev,
                            [issue.repoRoot]: {
                              ...prev[issue.repoRoot],
                              remoteBranch: nextBranch,
                            },
                          }));
                        }}
                      >
                        <SelectTrigger className="cf-git-filter-input h-9 text-xs">
                          <SelectValue placeholder={gt("dialogs.fixTrackedBranch.placeholders.remoteBranch", "选择远端分支")} />
                        </SelectTrigger>
                        <SelectContent>
                          {branches.map((branchName) => (
                            <SelectItem key={`${issue.repoRoot}:branch:${branchName}`} value={branchName}>
                              {branchName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="col-span-full flex items-center gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-2 text-xs">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-[var(--cf-border)]"
                        checked={form.setAsTracked}
                        disabled={!issue.canSetAsTracked}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setFormState((prev) => ({
                            ...prev,
                            [issue.repoRoot]: {
                              ...prev[issue.repoRoot],
                              setAsTracked: checked,
                            },
                          }));
                        }}
                      />
                      <Link2 className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                      <span>{gt("dialogs.fixTrackedBranch.setTracked", "同时写入 Git 跟踪分支配置；若不勾选，则仅对本次更新项目生效")}</span>
                    </label>
                  </div>
                ) : (
                  <div className="mt-4 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-2 text-xs text-[var(--cf-text-secondary)]">
                    {gt("dialogs.fixTrackedBranch.unsupported", "当前问题不支持在此对话框内自动修复，请先切换到本地分支并补齐上游后再继续。")}
                  </div>
                )}
              </div>
            );
          })}
          {hasFixableIssues && continueMode === "update" ? (
            <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
              <div className="text-sm font-medium">{gt("dialogs.fixTrackedBranch.continueMethod.title", "继续更新方式")}</div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {(["merge", "rebase"] as GitUpdateOptionMethod[]).map((method) => {
                  const checked = updateMethod === method;
                  return (
                    <label
                      key={method}
                      className={checked
                        ? "block cursor-pointer rounded-apple border border-[var(--cf-accent)] bg-[var(--cf-accent-light)] px-3 py-3 transition-colors"
                        : "block cursor-pointer rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3 transition-colors hover:bg-[var(--cf-surface-hover)]"}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="radio"
                          name="cf-tracked-branch-update-method"
                          className="mt-0.5 h-4 w-4"
                          checked={checked}
                          onChange={() => {
                            setUpdateMethod(method);
                          }}
                          />
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{getUpdateMethodLabel(method, gt)}</div>
                          <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                            {method === "rebase"
                              ? gt("dialogs.fixTrackedBranch.continueMethod.rebase", "应用修复后继续按变基方式更新。")
                              : gt("dialogs.fixTrackedBranch.continueMethod.merge", "应用修复后继续按合并方式更新。")}
                          </div>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </section>
          ) : null}
          {hasFixableIssues && continueMode === "reset" ? (
            <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3 text-sm text-[var(--cf-text-primary)]">
              {gt("dialogs.fixTrackedBranch.resetHint", "修复跟踪分支后会继续执行本次重置更新，不会改写已保存的合并 / 变基默认设置。")}
            </section>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-4">
          <Button size="xs" variant="secondary" onClick={onClose} disabled={submitting}>
            {hasFixableIssues
              ? gt("dialogs.fixTrackedBranch.actions.later", "稍后处理")
              : gt("dialogs.fixTrackedBranch.actions.close", "关闭")}
          </Button>
          {hasFixableIssues ? (
            <Button
              size="xs"
              onClick={() => onConfirm({ selections: validSelections, updateMethod })}
              disabled={submitting || !canConfirm}
            >
              {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              {continueMode === "reset"
                ? gt("dialogs.fixTrackedBranch.actions.applyAndContinueReset", "应用并继续重置")
                : gt("dialogs.fixTrackedBranch.actions.applyAndContinueUpdate", "应用并继续更新")}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
