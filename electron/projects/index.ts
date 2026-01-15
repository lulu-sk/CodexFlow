// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 统一入口：当前使用 fast 实现，若后续需要切换，仅改此处
export { scanProjectsAsync, addProjectByWinPath, touchProject, listProjectsFromStore } from "../projects.fast";
import fast from "../projects.fast";
export const IMPLEMENTATION_NAME = "fast";
export default fast;

