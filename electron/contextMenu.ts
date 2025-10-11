// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { Menu, type WebContents } from "electron";
import i18n from "./i18n";
import { getEditMenuLabelsForLocale, type EditMenuLabels } from "./locales/menu";

// 解析当前语言并获取编辑菜单的本地化标签
function resolveEditLabels(localeRaw?: string): EditMenuLabels {
  return getEditMenuLabelsForLocale(localeRaw);
}

// 安装输入框（可编辑元素）右键菜单：撤销/重做/剪切/复制/粘贴/全选
export function installInputContextMenu(wc: WebContents) {
  try {
    wc.on("context-menu", (event, params) => {
      try {
        if (!params?.isEditable) return; // 仅对可编辑元素启用

        // 根据当前语言构建菜单标签（遵循应用语言设置与统一回退）
        const L = resolveEditLabels(i18n.getCurrentLocale?.());

        // 根据 editFlags 控制可用性
        const f = params.editFlags || ({} as Electron.EditFlags);
        const template: Electron.MenuItemConstructorOptions[] = [
          { label: L.undo, role: "undo", enabled: !!f.canUndo },
          { label: L.redo, role: "redo", enabled: !!f.canRedo },
          { type: "separator" },
          { label: L.cut, role: "cut", enabled: !!f.canCut },
          { label: L.copy, role: "copy", enabled: !!f.canCopy },
          { label: L.paste, role: "paste", enabled: !!f.canPaste },
          { type: "separator" },
          { label: L.selectAll, role: "selectAll", enabled: !!f.canSelectAll },
        ];

        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: wc as any });
      } catch {}
    });
  } catch {}
}
