// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Eye, GitBranch, Loader2, Redo2, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import HistoryTurnDiffReviewDialog from "./history-turn-diff-review-dialog";
import { formatHistoryDiffPath, parseHistoryTurnDiff } from "./turn-diff";



type HistoryTurnDiffCardProps = {
  diffText: string;
  projectWinPath?: string;
  cwd?: string;
  patchable?: boolean;
  onOpenGit?: () => void;
  className?: string;
};

/**
* 显示 Codex 单轮文件差异，并提供完整审核与经过校验的撤销入口。
*/
export default function HistoryTurnDiffCard({ diffText, projectWinPath, cwd, patchable = true, onOpenGit, className }: HistoryTurnDiffCardProps) {
  const { t } = useTranslation(["history", "common", "git"]);
  const parsed = useMemo(() => parseHistoryTurnDiff(diffText), [diffText]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [patchAction, setPatchAction] = useState<"undo" | "reapply" | null>(null);
  const [reverted, setReverted] = useState(false);
  const [revertError, setRevertError] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const summaryFiles = parsed.summaryFiles.length > 0 ? parsed.summaryFiles : parsed.files;
  const visibleFiles = showAllFiles ? summaryFiles : summaryFiles.slice(0, 3);
  const hiddenFileCount = Math.max(0, summaryFiles.length - visibleFiles.length);
  const action = reverted ? "reapply" : "undo";
  const canPatchAction = patchable && !!projectWinPath && !!diffText.trim() && summaryFiles.length > 0 && patchAction === null;
  const gitLabel = String(t("git:workbench.misc.bottomTabs.git", "Git"));
  const title = summaryFiles.length === 1
    ? t("history:turnDiffEditedFile", { filename: formatHistoryDiffPath(summaryFiles[0]?.path || "", cwd, projectWinPath) })
    : t("history:turnDiffEditedFiles", { count: summaryFiles.length });

  useEffect(() => {
    setPatchAction(null);
    setReverted(false);
    setRevertError("");
    setShowAllFiles(false);
  }, [diffText]);

  /**
   * 请求主进程先校验，再撤销或重新应用当前历史差异。
   */
  const handlePatchAction = async (): Promise<void> => {
    if (!projectWinPath || !diffText.trim() || !canPatchAction) return;
    setPatchAction(action);
    setRevertError("");
    try {
      const result = await window.host.history.revertTurnDiff({ projectWinPath, diffText, operation: action });
      if (!result.ok) {
        setRevertError(result.error || String(t(action === "undo" ? "history:turnDiffRevertFailed" : "history:turnDiffReapplyFailed")));
        return;
      }
      setReverted(action === "undo");
    } catch (error) {
      setRevertError(String((error as Error)?.message || error || t(action === "undo" ? "history:turnDiffRevertFailed" : "history:turnDiffReapplyFailed")));
    } finally {
      setPatchAction(null);
    }
  };

  return (
    <>
      <div className={cn("min-w-0 overflow-hidden rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] shadow-apple-sm", className)}>
        <div className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2">
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-apple bg-[var(--cf-surface-solid)] text-[var(--cf-text-secondary)] shadow-apple-sm transition-colors hover:bg-[var(--cf-accent-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--cf-surface-solid)]"
            title={gitLabel}
            aria-label={gitLabel}
            disabled={!onOpenGit}
            onClick={onOpenGit}
          >
            <GitBranch className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-apple-semibold text-[var(--cf-text-primary)]">
              {reverted ? t("history:turnDiffReverted") : title}
            </div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{parsed.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">-{parsed.deletions}</span>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2"
              disabled={!canPatchAction}
              onClick={() => { void handlePatchAction(); }}
            >
              {patchAction ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : action === "undo" ? <RotateCcw className="mr-1.5 h-4 w-4" /> : <Redo2 className="mr-1.5 h-4 w-4" />}
              {patchAction ? t(action === "undo" ? "history:turnDiffReverting" : "history:turnDiffReapplying") : t(action === "undo" ? "history:turnDiffUndo" : "history:turnDiffReapply")}
            </Button>
            <Button size="sm" variant="secondary" className="h-8 px-2" onClick={() => setReviewOpen(true)}>
              <Eye className="mr-1.5 h-4 w-4" />
              {t("history:turnDiffReview")}
            </Button>
          </div>
        </div>

        {summaryFiles.length > 1 && visibleFiles.length > 0 ? (
          <div className="flex flex-col border-t border-[var(--cf-border)] px-3 py-1">
            {visibleFiles.map((file, index) => (
              <button
                key={`${file.path}-${index}`}
                type="button"
                className="flex h-9 min-w-0 items-center gap-3 border-b border-[var(--cf-border)]/70 text-start text-[11px] leading-5 transition-colors last:border-b-0 hover:bg-[var(--cf-accent-light)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--cf-accent)]/35"
                title={String(t("history:turnDiffReview"))}
                onClick={() => setReviewOpen(true)}
              >
                <span className="min-w-0 flex-1 truncate text-[var(--cf-text-secondary)]" title={file.path}>{formatHistoryDiffPath(file.path, cwd, projectWinPath)}</span>
                <span className="shrink-0 font-mono tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
                  <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                </span>
              </button>
            ))}
            {(hiddenFileCount > 0 || showAllFiles) ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-9 justify-start px-0 text-xs"
                onClick={() => setShowAllFiles((current) => !current)}
              >
                {showAllFiles
                  ? <>{t("history:turnDiffCollapseFiles")} <ChevronUp className="ml-1 h-3.5 w-3.5" /></>
                  : <>{t("history:turnDiffShowMoreFiles", { count: hiddenFileCount })} <ChevronDown className="ml-1 h-3.5 w-3.5" /></>}
              </Button>
            ) : null}
          </div>
        ) : null}
        {revertError ? (
          <div role="alert" className="flex gap-2 border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 whitespace-pre-wrap break-words">{revertError}</span>
          </div>
        ) : null}
      </div>

      <HistoryTurnDiffReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        files={parsed.files}
        rawFileCount={parsed.rawFileCount}
        additions={parsed.additions}
        deletions={parsed.deletions}
        cwd={cwd}
        projectWinPath={projectWinPath}
        action={action}
        patchAction={patchAction}
        canPatchAction={canPatchAction}
        onPatchAction={handlePatchAction}
      />
    </>
  );
}
