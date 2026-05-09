// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ActionDialogConfig, ActionDialogText } from "./action-dialog";

type CreateBranchDialogArgs = {
  description: ActionDialogText;
  defaultName?: string;
  title?: ActionDialogText;
  confirmText?: ActionDialogText;
};

type ChangeListTargetDialogArgs = {
  changeLists?: Array<{ id: string; name: string }>;
  activeChangeListId?: string;
};

/**
 * 构造 Git 对话框本地化文案描述，统一延迟到渲染阶段再按当前语言解析。
 */
export function buildGitDialogText(
  key: string,
  fallback: string,
  values?: Record<string, unknown>,
): ActionDialogText {
  return {
    key,
    fallback,
    ns: "git",
    values,
  };
}

/**
 * 生成“新建分支”类对话框配置，统一复用分支名称字段与默认占位符。
 */
export function buildCreateBranchDialogConfig({
  description,
  defaultName,
  title,
  confirmText,
}: CreateBranchDialogArgs): ActionDialogConfig {
  return {
    title: title || buildGitDialogText("actionDialogs.branch.title", "新建分支"),
    description,
    confirmText: confirmText || buildGitDialogText("actionDialogs.branch.confirm", "创建"),
    fields: [{
      key: "name",
      label: buildGitDialogText("actionDialogs.branch.nameLabel", "分支名称"),
      placeholder: buildGitDialogText("actionDialogs.branch.namePlaceholder", "feature/xxx"),
      required: true,
    }],
    defaults: defaultName ? { name: defaultName } : undefined,
  };
}

/**
 * 生成“新建标签”对话框配置，保持与分支创建弹窗相同的结构节奏。
 */
export function buildCreateTagDialogConfig(defaultName?: string): ActionDialogConfig {
  return {
    title: buildGitDialogText("actionDialogs.tag.title", "新建标签"),
    description: buildGitDialogText("actionDialogs.tag.description", "基于当前提交创建标签"),
    confirmText: buildGitDialogText("actionDialogs.tag.confirm", "创建"),
    fields: [{
      key: "name",
      label: buildGitDialogText("actionDialogs.tag.nameLabel", "标签名称"),
      placeholder: buildGitDialogText("actionDialogs.tag.namePlaceholder", "v1.0.0"),
      required: true,
    }],
    defaults: defaultName ? { name: defaultName } : undefined,
  };
}

/**
 * 生成“重置当前分支”对话框配置，用卡片模式直接表达 mixed / soft / hard 的差异。
 */
export function buildResetCurrentBranchDialogConfig(): ActionDialogConfig {
  return {
    title: buildGitDialogText("actionDialogs.reset.title", "重置当前分支"),
    description: buildGitDialogText("actionDialogs.reset.description", "请选择 reset 模式"),
    confirmText: buildGitDialogText("actionDialogs.reset.confirm", "执行"),
    footerHint: buildGitDialogText(
      "actionDialogs.reset.footerHint",
      "当前分支会移动到所选提交；执行后仍可通过 git reflog 找回历史。",
    ),
    width: "wide",
    fields: [{
      key: "mode",
      label: buildGitDialogText("actionDialogs.reset.modeLabel", "重置模式"),
      description: buildGitDialogText(
        "actionDialogs.reset.modeDescription",
        "不同模式会影响暂存区与工作区的保留方式，请确认后再执行。",
      ),
      type: "select",
      presentation: "cards",
      columns: 3,
      required: true,
      options: [
        {
          value: "mixed",
          label: buildGitDialogText("actionDialogs.reset.options.mixed.label", "混合（Mixed）"),
          description: buildGitDialogText(
            "actionDialogs.reset.options.mixed.description",
            "保留工作区改动，重置暂存区，适合撤销提交后继续整理文件。",
          ),
          badge: buildGitDialogText("actionDialogs.common.defaultBadge", "默认"),
          badgeVariant: "info",
        },
        {
          value: "soft",
          label: buildGitDialogText("actionDialogs.reset.options.soft.label", "软重置（Soft）"),
          description: buildGitDialogText(
            "actionDialogs.reset.options.soft.description",
            "仅移动当前分支指针，保留暂存区与工作区，适合重新组织提交。",
          ),
        },
        {
          value: "hard",
          label: buildGitDialogText("actionDialogs.reset.options.hard.label", "硬重置（Hard）"),
          description: buildGitDialogText(
            "actionDialogs.reset.options.hard.description",
            "同时重置 HEAD、暂存区与工作区，会直接丢弃未保存的本地改动。",
          ),
          tone: "danger",
        },
      ],
    }],
    defaults: { mode: "mixed" },
  };
}

/**
 * 生成“撤销提交”确认弹窗配置，统一补齐说明与安全提示，避免正文过空。
 */
export function buildUndoCommitDialogConfig(args?: {
  changeLists?: Array<{ id: string; name: string }>;
  activeChangeListId?: string;
}): ActionDialogConfig {
  const changeLists = Array.isArray(args?.changeLists) ? args?.changeLists : [];
  return {
    title: buildGitDialogText("actionDialogs.undoCommit.title", "撤销提交"),
    description: buildGitDialogText(
      "actionDialogs.undoCommit.description",
      changeLists.length > 0
        ? "将对当前 HEAD 提交执行 soft reset，保留工作区改动，并可把恢复出的变更移动到指定更改列表。"
        : "将对当前 HEAD 提交执行 soft reset，并保留工作区改动。",
    ),
    confirmText: buildGitDialogText("actionDialogs.undoCommit.confirm", "撤销"),
    footerHint: buildGitDialogText(
      "actionDialogs.undoCommit.footerHint",
      "该操作不会删除工作区中的文件内容，但会把当前提交从分支历史中移除。",
    ),
    fields: changeLists.length > 0 ? [{
      key: "targetChangeListId",
      label: buildGitDialogText("actionDialogs.undoCommit.targetChangeListLabel", "恢复到更改列表"),
      type: "select",
      options: changeLists.map((item) => ({
        value: item.id,
        label: item.name,
      })),
      required: true,
      description: buildGitDialogText(
        "actionDialogs.undoCommit.targetChangeListDescription",
        "撤销后的文件将移动到所选更改列表，并把原提交消息回填到对应草稿。",
      ),
    }] : [],
    defaults: changeLists.length > 0
      ? { targetChangeListId: String(args?.activeChangeListId || changeLists[0]?.id || "") }
      : undefined,
  };
}

/**
 * 生成“删除提交”确认弹窗配置，对齐 IDEA 在执行 drop 前的确认与“不再询问”入口。
 */
export function buildDeleteCommitDialogConfig(args: {
  commitCount: number;
  branchName?: string;
}): ActionDialogConfig {
  const commitCount = Number.isFinite(args.commitCount) && args.commitCount > 0
    ? Math.floor(args.commitCount)
    : 1;
  const branchName = String(args.branchName || "").trim();
  return {
    title: buildGitDialogText("actionDialogs.deleteCommit.title", "删除提交"),
    tone: "danger",
    description: branchName
      ? buildGitDialogText(
        "actionDialogs.deleteCommit.description",
        "是否要从“{{branch}}”分支删除 {{count}} 个提交？",
        { branch: branchName, count: commitCount },
      )
      : buildGitDialogText(
        "actionDialogs.deleteCommit.descriptionDetached",
        "是否要删除 {{count}} 个提交？",
        { count: commitCount },
      ),
    confirmText: buildGitDialogText("actionDialogs.deleteCommit.confirm", "删除"),
    footerHint: buildGitDialogText(
      "actionDialogs.deleteCommit.footerHint",
      "该操作会改写当前分支历史；若这些提交已推送到远端，请谨慎执行。",
    ),
    fields: [{
      key: "dontAskAgain",
      label: buildGitDialogText("actionDialogs.deleteCommit.dontAskAgain", "不再询问"),
      type: "checkbox",
    }],
    defaults: { dontAskAgain: "false" },
  };
}

/**
 * 生成“优选/还原所选更改”对话框配置；启用 changelist 时要求先选择目标更改列表，对齐 IDEA 的 committed changes patch 流程。
 */
export function buildCommitDetailsPatchDialogConfig(
  mode: "revert" | "apply",
  args?: ChangeListTargetDialogArgs,
): ActionDialogConfig {
  const changeLists = Array.isArray(args?.changeLists) ? args?.changeLists : [];
  const isApply = mode === "apply";
  return {
    title: isApply
      ? buildGitDialogText("actionDialogs.commitDetailsPatch.applyTitle", "优选所选更改")
      : buildGitDialogText("actionDialogs.commitDetailsPatch.revertTitle", "还原所选更改"),
    description: isApply
      ? buildGitDialogText(
        "actionDialogs.commitDetailsPatch.applyDescription",
        "把当前提交详情里选中的更改应用到工作区；启用更改列表时，可指定目标更改列表。",
      )
      : buildGitDialogText(
        "actionDialogs.commitDetailsPatch.revertDescription",
        "把当前提交详情里选中的更改以反向补丁形式应用到工作区；启用更改列表时，可指定目标更改列表。",
      ),
    confirmText: isApply
      ? buildGitDialogText("actionDialogs.commitDetailsPatch.applyConfirm", "优选")
      : buildGitDialogText("actionDialogs.commitDetailsPatch.revertConfirm", "还原"),
    fields: changeLists.length > 0 ? [{
      key: "targetChangeListId",
      label: buildGitDialogText("actionDialogs.commitDetailsPatch.targetChangeListLabel", "目标更改列表"),
      type: "select",
      options: changeLists.map((item) => ({
        value: item.id,
        label: item.name,
      })),
      required: true,
      description: isApply
        ? buildGitDialogText(
          "actionDialogs.commitDetailsPatch.applyTargetDescription",
          "应用后的文件会归入所选更改列表，避免直接落到错误列表。",
        )
        : buildGitDialogText(
          "actionDialogs.commitDetailsPatch.revertTargetDescription",
          "还原后的文件会归入所选更改列表，便于后续继续整理。",
        ),
    }] : [],
    defaults: changeLists.length > 0
      ? { targetChangeListId: String(args?.activeChangeListId || changeLists[0]?.id || "") }
      : undefined,
  };
}

/**
 * 生成“编辑提交消息”对话框配置，统一说明 HEAD 与非 HEAD 提交的执行差异。
 */
export function buildEditCommitMessageDialogConfig(draftMessage: string): ActionDialogConfig {
  return {
    title: buildGitDialogText("actionDialogs.editCommitMessage.title", "编辑提交信息"),
    description: buildGitDialogText(
      "actionDialogs.editCommitMessage.description",
      "支持编辑当前分支历史线上的提交消息（非 HEAD 会通过自动化 rebase 方式执行）。",
    ),
    confirmText: buildGitDialogText("actionDialogs.editCommitMessage.confirm", "保存"),
    footerHint: buildGitDialogText(
      "actionDialogs.editCommitMessage.footerHint",
      "修改非 HEAD 提交时会自动进入一次受控 rebase，保存前请确认消息内容。",
    ),
    width: "wide",
    fields: [{
      key: "message",
      label: buildGitDialogText("actionDialogs.editCommitMessage.messageLabel", "提交信息"),
      placeholder: buildGitDialogText("actionDialogs.editCommitMessage.messagePlaceholder", "请输入新的提交信息"),
      required: true,
      type: "textarea",
      rows: 10,
    }],
    defaults: { message: draftMessage || "" },
  };
}
