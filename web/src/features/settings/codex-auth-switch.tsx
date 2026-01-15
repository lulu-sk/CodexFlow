// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { CodexAuthBackupItem } from "@/types/host";
import { emitCodexAuthChanged } from "@/lib/codex-status";

export type CodexAuthSwitchProps = {
  open: boolean;
  recordEnabled: boolean;
  onRecordEnabledChange: (enabled: boolean) => void;
};

type LoadState = {
  loading: boolean;
  error: string | null;
  items: CodexAuthBackupItem[];
};

/**
 * 格式化备份列表展示文案：以“登录状态”为主，展示“账号状态值 + 套餐”。
 */
function formatBackupLabel(item: CodexAuthBackupItem, t: TFunction): string {
  const signedText = t(`settings:codexAccount.switch.status.${item.status}`) as string;
  const statusValue = (() => {
    const email = String(item.email || "").trim();
    if (email) return email;
    const accountId = String(item.accountId || "").trim();
    if (accountId) return accountId;
    const userId = String(item.userId || "").trim();
    if (userId) return userId;
    return t("settings:codexAccount.statusUnknown", "未登录") as string;
  })();
  const planText = (() => {
    const plan = String(item.plan || "").trim();
    if (!plan) return t("settings:codexAccount.plan.unknown", "未知套餐") as string;
    const key = `settings:codexAccount.plan.${plan}`;
    const translated = t(key) as string;
    return translated && translated !== key ? translated : plan;
  })();
  return [signedText, statusValue, planText].filter(Boolean).join(" · ");
}

/**
 * 设置面板：Codex auth.json 备份列表与一键切换入口。
 */
export const CodexAuthSwitch: React.FC<CodexAuthSwitchProps> = ({ open, recordEnabled, onRecordEnabledChange }) => {
  const { t } = useTranslation(["settings", "common"]);
  const [state, setState] = useState<LoadState>({ loading: false, error: null, items: [] });
  const [selectedId, setSelectedId] = useState<string>("");
  const [switching, setSwitching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const refreshList = useCallback(async () => {
    setFeedback(null);
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      // 先触发一次账号刷新，让主进程有机会补齐备份 meta（例如套餐/邮箱在上一轮未拿到的情况）
      try { await window.host.codex.getAccountInfo(); } catch {}
      const res = await window.host.codex.listAuthBackups();
      if (res && res.ok && Array.isArray(res.items)) {
        const items = res.items as CodexAuthBackupItem[];
        setState({ loading: false, error: null, items });
        setSelectedId((cur) => (cur && items.some((x) => x.id === cur) ? cur : (items[0]?.id || "")));
        return;
      }
      setState({
        loading: false,
        error: (res && res.error) ? String(res.error) : (t("settings:codexAccount.switch.loadFailed") as string),
        items: [],
      });
    } catch (e) {
      setState({
        loading: false,
        error: String(e || t("settings:codexAccount.switch.loadFailed")),
        items: [],
      });
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    refreshList();
  }, [open, refreshList]);

  const selectedLabel = useMemo(() => {
    const hit = state.items.find((x) => x.id === selectedId);
    if (hit) return formatBackupLabel(hit, t);
    if (state.items.length > 0) return t("settings:codexAccount.switch.selectPlaceholder") as string;
    return t("settings:codexAccount.switch.empty") as string;
  }, [selectedId, state.items, t]);

  const canSwitch = !!selectedId && !switching && !deleting && !state.loading && state.items.some((x) => x.id === selectedId);
  const canDelete = !!selectedId && !deleting && !switching && !state.loading && state.items.some((x) => x.id === selectedId);

  const applySelected = useCallback(async () => {
    if (!canSwitch) return;
    setFeedback(null);
    setSwitching(true);
    try {
      const res = await window.host.codex.applyAuthBackup({ id: selectedId });
      if (res && res.ok) {
        setFeedback({ ok: true, text: t("settings:codexAccount.switch.switchSuccess") as string });
        // 通知全局：账号已切换，强制刷新顶部栏用量与设置面板账号状态
        emitCodexAuthChanged("settings-switch");
        await refreshList();
      } else {
        setFeedback({ ok: false, text: (res && res.error) ? String(res.error) : (t("settings:codexAccount.switch.switchFailed") as string) });
      }
    } catch (e) {
      setFeedback({ ok: false, text: String(e || t("settings:codexAccount.switch.switchFailed")) });
    } finally {
      setSwitching(false);
    }
  }, [canSwitch, refreshList, selectedId, t]);

  /**
   * 删除当前选中的备份（同时删除 meta 与 auth 文件）。
   */
  const deleteSelected = useCallback(async () => {
    if (!canDelete) return;
    const hit = state.items.find((x) => x.id === selectedId);
    const label = hit ? formatBackupLabel(hit, t) : selectedId;
    const ok = window.confirm(
      t("settings:codexAccount.switch.deleteConfirm", { label }) as string
    );
    if (!ok) return;
    setFeedback(null);
    setDeleting(true);
    try {
      const res = await window.host.codex.deleteAuthBackup({ id: selectedId });
      if (res && res.ok) {
        setFeedback({ ok: true, text: t("settings:codexAccount.switch.deleteSuccess") as string });
        await refreshList();
      } else {
        setFeedback({ ok: false, text: (res && res.error) ? String(res.error) : (t("settings:codexAccount.switch.deleteFailed") as string) });
      }
    } catch (e) {
      setFeedback({ ok: false, text: String(e || t("settings:codexAccount.switch.deleteFailed")) });
    } finally {
      setDeleting(false);
    }
  }, [canDelete, refreshList, selectedId, state.items, t]);

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
          checked={recordEnabled}
          onChange={(e) => onRecordEnabledChange(e.target.checked)}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
            {t("settings:codexAccount.record.label")}
          </div>
          <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
            {t("settings:codexAccount.record.desc")}
          </p>
        </div>
      </label>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] items-center">
        <Select value={selectedId} onValueChange={(v) => setSelectedId(String(v || ""))}>
          <SelectTrigger
            className="h-auto min-h-10 py-2 items-start"
            disabled={!open || state.loading || state.items.length === 0}
          >
            <span className="text-left whitespace-normal break-all leading-snug" title={selectedLabel}>
              {selectedLabel}
            </span>
          </SelectTrigger>
          <SelectContent>
            {state.items.map((item) => {
              const label = formatBackupLabel(item, t);
              return (
                <SelectItem key={item.id} value={item.id}>
                  <span className="whitespace-normal break-all leading-snug" title={label}>
                    {label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          disabled={!open || state.loading}
          onClick={() => refreshList()}
        >
          {state.loading ? t("settings:loading") : t("settings:codexAccount.switch.refreshList")}
        </Button>

        <Button
          variant="secondary"
          disabled={!canSwitch}
          onClick={() => applySelected()}
        >
          {switching ? t("settings:codexAccount.switch.switching") : t("settings:codexAccount.switch.switch")}
        </Button>

        <Button
          variant="danger"
          disabled={!canDelete}
          onClick={() => deleteSelected()}
        >
          {deleting ? t("settings:codexAccount.switch.deleting") : t("settings:codexAccount.switch.delete")}
        </Button>
      </div>

      {state.error ? (
        <div className="text-xs text-[var(--cf-red)]">{state.error}</div>
      ) : feedback ? (
        <div className={`text-xs ${feedback.ok ? "text-slate-600 dark:text-[var(--cf-text-secondary)]" : "text-[var(--cf-red)]"}`}>
          {feedback.text}
        </div>
      ) : null}
    </div>
  );
};
