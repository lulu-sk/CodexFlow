import React from "react";
import { AlertTriangle, GitMerge, GitPullRequestArrow, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { interpolateI18nText } from "@/lib/translate";
import type { GitPushRejectedAction, GitPushRejectedDecision } from "./types";

type PushRejectedDialogProps = {
  open: boolean;
  decision: GitPushRejectedDecision | null;
  submitting: boolean;
  onClose(): void;
  onAction(action: GitPushRejectedAction): void;
};

/**
 * 将 Push Rejected 的动作视觉语义映射为按钮样式，保持主次决策层级稳定。
 */
function getPushRejectedActionVariant(action: GitPushRejectedAction): "default" | "secondary" | "danger" {
  if (action.variant === "danger") return "danger";
  if (action.variant === "primary") return "default";
  return "secondary";
}

/**
 * 为 Push Rejected 对话框渲染统一元信息，帮助用户确认当前受影响的分支与远端。
 */
function renderDecisionMeta(
  decision: GitPushRejectedDecision,
  resolveLabel: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): JSX.Element {
  const badgeLabel = decision.type === "stale-info"
    ? resolveLabel("dialogs.pushRejected.badges.leaseExpired", "租约保护已过期")
    : decision.type === "rejected-other"
      ? resolveLabel("dialogs.pushRejected.badges.remoteRejected", "远端拒绝")
      : resolveLabel("dialogs.pushRejected.badges.pushRejected", "推送被拒绝");
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--cf-text-secondary)]">
      <Badge variant="secondary" className="text-[10px]">{badgeLabel}</Badge>
      {decision.branch ? (
        <span className="inline-flex items-center gap-1.5">
          <GitPullRequestArrow className="h-3.5 w-3.5 text-[var(--cf-orange)]" />
          {resolveLabel("dialogs.pushRejected.meta.localBranch", "本地分支：{{branch}}", { branch: decision.branch })}
        </span>
      ) : null}
      {decision.upstream ? (
        <Badge variant="secondary" className="text-[10px]">
          {resolveLabel("dialogs.pushRejected.meta.upstream", "上游：{{branch}}", { branch: decision.upstream })}
        </Badge>
      ) : null}
      {decision.remote && decision.remoteBranch ? (
        <Badge variant="secondary" className="text-[10px]">
          {resolveLabel("dialogs.pushRejected.meta.target", "目标：{{remote}}/{{branch}}", { remote: decision.remote, branch: decision.remoteBranch })}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * 渲染 Push 被拒绝后的正式决策对话框，按 rejected 类型切换说明卡片与动作语义。
 */
export function PushRejectedDialog(props: PushRejectedDialogProps): JSX.Element | null {
  const { t } = useTranslation("git");
  const { open, decision, submitting, onClose, onAction } = props;
  if (!decision) return null;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, {
      ns: "git",
      defaultValue: fallback,
      ...(values || {}),
    })), values);
  }, [t]);
  const decisionCards = decision.type === "stale-info"
    ? [
      {
        key: "force",
        icon: <ShieldAlert className="h-3.5 w-3.5 text-[var(--cf-danger)]" />,
        title: gt("dialogs.pushRejected.cards.staleInfo.force.title", "继续强制推送"),
        description: gt("dialogs.pushRejected.cards.staleInfo.force.description", "改用普通强制推送会移除 lease 保护，仅在你确认要覆盖远端当前引用时使用。"),
      },
      {
        key: "cancel",
        icon: <AlertTriangle className="h-3.5 w-3.5 text-[var(--cf-orange)]" />,
        title: gt("dialogs.pushRejected.cards.staleInfo.cancel.title", "取消"),
        description: gt("dialogs.pushRejected.cards.staleInfo.cancel.description", "保留当前状态，不再继续推送；你可以先拉取、检查远端历史，再决定是否覆盖。"),
      },
    ]
    : decision.type === "rejected-other"
      ? [
        {
          key: "policy",
          icon: <ShieldAlert className="h-3.5 w-3.5 text-[var(--cf-orange)]" />,
          title: gt("dialogs.pushRejected.cards.rejectedOther.policy.title", "先处理远端限制"),
        description: gt("dialogs.pushRejected.cards.rejectedOther.policy.description", "这类拒绝通常来自分支保护、服务端钩子或平台策略，需要先解除远端限制后再重试。"),
        },
        {
          key: "cancel",
          icon: <AlertTriangle className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />,
          title: gt("dialogs.pushRejected.cards.rejectedOther.cancel.title", "关闭"),
          description: gt("dialogs.pushRejected.cards.rejectedOther.cancel.description", "先保留当前提交状态，稍后在满足远端规则后重新发起推送。"),
        },
      ]
      : [
        {
          key: "update",
          icon: <GitMerge className="h-3.5 w-3.5 text-[var(--cf-accent)]" />,
          title: gt("dialogs.pushRejected.cards.needsUpdate.update.title", "先更新再推送"),
          description: gt("dialogs.pushRejected.cards.needsUpdate.update.description", "可选择合并或变基，更新过程会进入正式更新会话，并在成功后继续重试推送。"),
        },
        {
          key: "force-with-lease",
          icon: <ShieldAlert className="h-3.5 w-3.5 text-[var(--cf-orange)]" />,
          title: gt("dialogs.pushRejected.cards.needsUpdate.forceWithLease.title", "保留租约保护的强制推送"),
          description: gt("dialogs.pushRejected.cards.needsUpdate.forceWithLease.description", "仅在确认远端变更应被当前提交覆盖时使用，仍保留租约保护，避免盲目强推。"),
        },
        {
          key: "cancel",
          icon: <AlertTriangle className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />,
          title: gt("dialogs.pushRejected.cards.needsUpdate.cancel.title", "取消"),
          description: gt("dialogs.pushRejected.cards.needsUpdate.cancel.description", "保留当前推送对话框状态，稍后可手动调整更新方式、目标分支或直接关闭。"),
        },
      ];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent data-testid="push-rejected-dialog" className="cf-git-dialog-panel w-[720px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-[var(--cf-orange)]" />
            {decision.title}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">{decision.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          {renderDecisionMeta(decision, gt)}
          <div className={`grid gap-3 ${decisionCards.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
            {decisionCards.map((card) => (
              <div
                key={card.key}
                className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-3 text-xs text-[var(--cf-text-secondary)]"
              >
                <div className="mb-1 flex items-center gap-1.5 font-medium text-[var(--cf-text-primary)]">
                  {card.icon}
                  {card.title}
                </div>
                <div>{card.description}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-4">
          {decision.actions.map((action) => (
            <Button
              key={`${action.kind}:${action.label}`}
              data-testid={`push-rejected-action-${action.kind}`}
              size="xs"
              variant={getPushRejectedActionVariant(action)}
              disabled={submitting}
              onClick={() => {
                onAction(action);
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
