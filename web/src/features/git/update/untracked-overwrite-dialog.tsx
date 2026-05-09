// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { SmartOperationDialog } from "./smart-operation-dialog";
import type { UpdateOperationDialogProps } from "./types";

/**
 * 渲染未跟踪文件覆盖专属对话框，显式承接 `untracked-overwritten` 语义，避免该边界只散落在工作台条件判断里。
 */
export function UntrackedOverwriteDialog(props: UpdateOperationDialogProps): JSX.Element | null {
  if (props.problem?.kind !== "untracked-overwritten") return null;
  return <SmartOperationDialog {...props} />;
}
