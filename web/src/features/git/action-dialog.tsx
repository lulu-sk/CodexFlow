// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { interpolateI18nText } from "@/lib/translate";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type ActionDialogBadgeVariant = "default" | "secondary" | "outline" | "danger" | "success" | "warning" | "info";

export type ActionDialogText =
  | string
  | {
    key: string;
    fallback: string;
    ns?: string;
    values?: Record<string, unknown>;
  };

export type ActionDialogOption = {
  value: string;
  label: ActionDialogText;
  description?: ActionDialogText;
  badge?: ActionDialogText;
  badgeVariant?: ActionDialogBadgeVariant;
  tone?: "default" | "danger" | "warning" | "info" | "success";
};

export type ActionDialogField = {
  key: string;
  label: ActionDialogText;
  placeholder?: ActionDialogText;
  type?: "text" | "select" | "textarea" | "checkbox";
  required?: boolean;
  description?: ActionDialogText;
  options?: ActionDialogOption[];
  rows?: number;
  presentation?: "dropdown" | "cards";
  columns?: 2 | 3;
};

export type ActionDialogConfig = {
  title: ActionDialogText;
  description?: ActionDialogText;
  confirmText?: ActionDialogText;
  cancelText?: ActionDialogText;
  footerHint?: ActionDialogText;
  fields: ActionDialogField[];
  defaults?: Record<string, string>;
  width?: "regular" | "wide";
  tone?: "default" | "danger";
};

type GitActionDialogProps = {
  open: boolean;
  config: ActionDialogConfig | null;
  values: Record<string, string>;
  submitting: boolean;
  onClose(): void;
  onSubmit(): void;
  onChangeField(key: string, value: string): void;
};

/**
 * 把对话框文案统一解析为当前语言下的最终字符串，避免配置在打开时就被固化。
 */
export function resolveActionDialogText(text: ActionDialogText | undefined, t: TFunction): string {
  if (!text) return "";
  if (typeof text === "string") return text;
  return interpolateI18nText(String(t(text.key, {
    ns: text.ns || "git",
    defaultValue: text.fallback,
    ...(text.values || {}),
  }) || ""), text.values);
}

/**
 * 判断字段是否应按卡片模式渲染，当前仅为少量高语义 select 场景开放。
 */
function isCardSelectField(field: ActionDialogField): boolean {
  return field.type === "select" && field.presentation === "cards" && Array.isArray(field.options) && field.options.length > 0;
}

/**
 * 根据配置与字段内容推导弹窗宽度，保证 textarea / 卡片选择类弹窗拥有足够阅读空间。
 */
function resolveDialogWidthClass(config: ActionDialogConfig): string {
  if (config.width === "wide") return "w-[680px]";
  if (config.fields.some((field) => field.type === "textarea" || isCardSelectField(field))) return "w-[680px]";
  return "w-[560px]";
}

/**
 * 根据弹窗 tone 返回标题区样式；危险确认场景使用柔和警示色，避免过于刺眼。
 */
function resolveDialogHeaderClass(config: ActionDialogConfig): string {
  if (config.tone === "danger") return "border-b border-[var(--cf-danger)]/18 bg-[linear-gradient(180deg,rgba(255,240,238,0.96),rgba(255,248,246,0.94))] dark:bg-[linear-gradient(180deg,rgba(68,24,18,0.78),rgba(43,26,23,0.72))]";
  return "border-b border-[var(--cf-border)]";
}

/**
 * 根据弹窗 tone 返回底部提示区样式，让危险操作的说明与按钮形成统一层级。
 */
function resolveDialogFooterClass(config: ActionDialogConfig): string {
  if (config.tone === "danger") return "border-t border-[var(--cf-danger)]/12 bg-[linear-gradient(180deg,rgba(255,250,248,0.96),rgba(255,244,241,0.98))] dark:bg-[linear-gradient(180deg,rgba(43,26,23,0.72),rgba(58,31,26,0.78))]";
  return "border-t border-[var(--cf-border)]";
}

/**
 * 根据弹窗 tone 选择主按钮视觉语义，危险确认场景使用 danger 变体。
 */
function resolveDialogSubmitVariant(config: ActionDialogConfig): NonNullable<React.ComponentProps<typeof Button>["variant"]> {
  return config.tone === "danger" ? "danger" : "default";
}

/**
 * 根据字段声明返回卡片网格列数，优先保证 reset 等三选项场景在桌面端同屏展示。
 */
function resolveCardColumnsClass(field: ActionDialogField): string {
  return field.columns === 3
    ? "md:grid-cols-3"
    : "md:grid-cols-2";
}

/**
 * 为卡片选项提供统一色彩语义，突出危险操作但不破坏整体视觉节奏。
 */
function resolveOptionToneClass(option: ActionDialogOption, selected: boolean): string {
  if (selected) {
    if (option.tone === "danger") return "border-[var(--cf-danger)] bg-[var(--cf-danger)]/10";
    if (option.tone === "warning") return "border-[var(--cf-yellow)] bg-[var(--cf-yellow-light)]/70";
    if (option.tone === "success") return "border-[var(--cf-green)] bg-[var(--cf-green-light)]/70";
    if (option.tone === "info") return "border-[var(--cf-teal)] bg-[var(--cf-teal-light)]/70";
    return "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]";
  }
  return "border-[var(--cf-border)] bg-[var(--cf-surface-muted)] hover:bg-[var(--cf-surface-hover)]";
}

/**
 * 渲染 Git 通用动作对话框，统一简单表单、确认弹窗与 reset 模式卡片的视觉层级。
 */
export function GitActionDialog({
  open,
  config,
  values,
  submitting,
  onClose,
  onSubmit,
  onChangeField,
}: GitActionDialogProps): React.JSX.Element | null {
  const { t } = useTranslation(["git", "common"]);
  if (!open || !config) return null;

  const titleText = resolveActionDialogText(config.title, t);
  const descriptionText = resolveActionDialogText(config.description, t);
  const cancelText = resolveActionDialogText(config.cancelText, t) || String(t("actionDialogs.common.cancel", { ns: "git", defaultValue: "取消" }));
  const confirmText = resolveActionDialogText(config.confirmText, t) || String(t("actionDialogs.common.confirm", { ns: "git", defaultValue: "确定" }));
  const footerHintText = resolveActionDialogText(config.footerHint, t);
  const submitVariant = resolveDialogSubmitVariant(config);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className={cn(
        "cf-git-dialog-panel max-w-[calc(100vw-3rem)] overflow-hidden p-0",
        resolveDialogWidthClass(config),
        config.tone === "danger" ? "shadow-[0_24px_64px_rgba(122,42,28,0.18)]" : "",
      )}>
        <DialogHeader className={cn("px-5 py-4", resolveDialogHeaderClass(config))}>
          <DialogTitle className={cn("text-base font-semibold", config.tone === "danger" ? "text-[var(--cf-danger)]" : "")}>
            {titleText}
          </DialogTitle>
          {descriptionText ? (
            <DialogDescription className={cn(
              "text-sm leading-6",
              config.tone === "danger"
                ? "text-[color:rgba(115,57,47,0.92)] dark:text-[color:rgba(255,225,220,0.9)]"
                : "text-[var(--cf-text-secondary)]",
            )}>
              {descriptionText}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {config.fields.length <= 0 ? (
            <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
              <div className="text-sm leading-6 text-[var(--cf-text-primary)]">
                {descriptionText || titleText}
              </div>
            </section>
          ) : (
            <div className="space-y-4">
              {config.fields.map((field) => {
                const value = String(values[field.key] ?? "");
                const labelText = resolveActionDialogText(field.label, t);
                const placeholderText = resolveActionDialogText(field.placeholder, t);
                const fieldDescriptionText = resolveActionDialogText(field.description, t);

                if (field.type === "checkbox") {
                  const checked = value === "true";
                  return (
                    <button
                      key={field.key}
                      type="button"
                      className={cn(
                        "w-full rounded-apple border px-4 py-3 text-left transition-all duration-apple",
                        checked
                          ? config.tone === "danger"
                            ? "border-[var(--cf-danger)]/35 bg-[linear-gradient(180deg,rgba(255,242,239,0.95),rgba(255,248,246,0.98))] shadow-apple-sm"
                            : "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]"
                          : config.tone === "danger"
                            ? "border-[var(--cf-border)] bg-[rgba(255,255,255,0.86)] hover:border-[var(--cf-danger)]/22 hover:bg-[rgba(255,248,246,0.98)] dark:bg-[rgba(42,35,33,0.94)]"
                            : "border-[var(--cf-border)] bg-[var(--cf-surface-muted)] hover:bg-[var(--cf-surface-hover)]",
                      )}
                      onClick={() => onChangeField(field.key, checked ? "false" : "true")}
                      data-testid={`action-dialog-checkbox-${field.key}`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          className={cn(
                            "h-4 w-4 shrink-0 accent-[var(--cf-accent)]",
                            config.tone === "danger" ? "accent-[var(--cf-danger)]" : "",
                          )}
                          checked={checked}
                          readOnly
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-[var(--cf-text-primary)]">{labelText}</div>
                          {fieldDescriptionText ? (
                            <div className="mt-1 text-xs leading-5 text-[var(--cf-text-secondary)]">{fieldDescriptionText}</div>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  );
                }

                return (
                  <label key={field.key} className="block">
                    <div className="mb-1.5 text-sm font-medium text-[var(--cf-text-primary)]">{labelText}</div>
                    {fieldDescriptionText ? (
                      <div className="mb-2 text-xs leading-5 text-[var(--cf-text-secondary)]">{fieldDescriptionText}</div>
                    ) : null}

                    {isCardSelectField(field) ? (
                      <div className={cn("grid gap-3", resolveCardColumnsClass(field))}>
                        {(field.options || []).map((option) => {
                          const selected = value === option.value;
                          const optionLabel = resolveActionDialogText(option.label, t);
                          const optionDescription = resolveActionDialogText(option.description, t);
                          const optionBadge = resolveActionDialogText(option.badge, t);
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={cn(
                                "rounded-apple border px-4 py-3 text-left transition-colors",
                                resolveOptionToneClass(option, selected),
                              )}
                              onClick={() => onChangeField(field.key, option.value)}
                              data-testid={`action-dialog-option-${field.key}-${option.value}`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="text-sm font-medium text-[var(--cf-text-primary)]">{optionLabel}</div>
                                {optionBadge ? (
                                  <Badge variant={option.badgeVariant || "secondary"} className="shrink-0 text-[10px]">
                                    {optionBadge}
                                  </Badge>
                                ) : null}
                              </div>
                              {optionDescription ? (
                                <div
                                  className={cn(
                                    "mt-1.5 text-xs leading-5",
                                    option.tone === "danger"
                                      ? "text-[var(--cf-danger)]"
                                      : "text-[var(--cf-text-secondary)]",
                                  )}
                                >
                                  {optionDescription}
                                </div>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : field.type === "select" ? (
                      <Select value={value} onValueChange={(nextValue) => onChangeField(field.key, nextValue)}>
                        <SelectTrigger className="cf-git-filter-input h-10 text-sm" title={labelText}>
                          <SelectValue placeholder={placeholderText || labelText} />
                        </SelectTrigger>
                        <SelectContent>
                          {(field.options || []).map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {resolveActionDialogText(option.label, t)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : field.type === "textarea" ? (
                      <textarea
                        autoFocus={config.fields.length === 1}
                        className="cf-git-editor-input min-h-[220px] w-full resize-y rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-3 text-sm leading-6 shadow-apple-inner transition-all duration-apple hover:border-[var(--cf-border-strong)] focus-visible:border-[var(--cf-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/50"
                        rows={Math.max(4, Number(field.rows) || 10)}
                        placeholder={placeholderText}
                        value={value}
                        onChange={(event) => onChangeField(field.key, event.target.value)}
                        data-testid={`action-dialog-textarea-${field.key}`}
                      />
                    ) : (
                      <Input
                        autoFocus={config.fields.length === 1}
                        className="cf-git-filter-input h-10 text-sm"
                        placeholder={placeholderText}
                        value={value}
                        onChange={(event) => onChangeField(field.key, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            onSubmit();
                          }
                        }}
                        data-testid={`action-dialog-input-${field.key}`}
                      />
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className={cn("flex items-center justify-between gap-3 px-5 py-3.5", resolveDialogFooterClass(config))}>
          <div className={cn(
            "min-h-[1rem] text-[11px] leading-5",
            config.tone === "danger"
              ? "max-w-[360px] text-[color:rgba(108,66,58,0.92)] dark:text-[color:rgba(255,218,212,0.84)]"
              : "text-[var(--cf-text-secondary)]",
          )}>
            {footerHintText}
          </div>
          <div className="flex items-center gap-2">
            <Button size="xs" variant="secondary" onClick={onClose} data-cf-dialog-cancel="true" data-testid="action-dialog-cancel">
              {cancelText}
            </Button>
            <Button size="xs" variant={submitVariant} onClick={onSubmit} disabled={submitting} data-cf-dialog-primary="true" data-testid="action-dialog-submit">
              {confirmText}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
