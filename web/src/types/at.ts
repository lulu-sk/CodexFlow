// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// at 搜索与弹窗相关类型（仅 UI 壳用）
// 说明：此模块仅定义前端 UI 所需的基本类型，数据来源使用内置 mock。

export type AtCategoryId = "files" | "rule";

export interface AtCategory {
  id: AtCategoryId;
  name: string;
  /** lucide-react 的图标组件名称（在使用处解析） */
  icon: string;
}

export interface AtItemBase {
  id: string;
  categoryId: AtCategoryId;
  /** 主标题（如文件名、规则名） */
  title: string;
  /** 次要信息（如相对路径、分组标签） */
  subtitle?: string;
  /** 图标名称（lucide-react） */
  icon?: string;
}

export interface FileItem extends AtItemBase {
  categoryId: "files";
  /** 完整路径（仅 UI 展示，不参与替换） */
  path: string;
  /** 是否目录 */
  isDir?: boolean;
}

export interface RuleItem extends AtItemBase {
  categoryId: "rule";
  /** 所属分组（示例：IDC、Lint 等） */
  group?: string;
  /** 规则文件的相对路径或完整路径（如 .cursor/index.mdc） */
  path?: string;
}

export type AtItem = FileItem | RuleItem;

export type SearchScope = "all" | AtCategoryId;

export interface SearchResult {
  item: AtItem;
  /** 排序用得分，越大越靠前 */
  score: number;
}


