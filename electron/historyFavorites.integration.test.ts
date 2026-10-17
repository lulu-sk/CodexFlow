// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createHistoryFavoriteMatcher } from "./historyFavorites";
import { createHistoryScopeMatcher } from "./historyScope";
import { selectCurrentHistorySummaries } from "./codexRollout";

/** 提取真实 IPC 注册语句，在隔离依赖中执行，避免测试启动 Electron 或访问本机历史。 */
function loadHistoryHandler(channel: string, dependencies: Record<string, unknown>) {
  const source = fs.readFileSync(path.resolve("electron/main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = ast.statements.find((node) => {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
    const expression = node.expression;
    return expression.expression.getText(ast) === "ipcMain.handle"
      && ts.isStringLiteral(expression.arguments[0]) && expression.arguments[0].text === channel;
  });
  if (!statement) throw new Error(`缺少 IPC 注册：${channel}`);
  let handler!: (event: unknown, args: Record<string, unknown>) => Promise<any>;
  const context = { ...dependencies, ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } };
  const compiled = ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function(...Object.keys(context), compiled)(...Object.values(context));
  return handler;
}

/** 为真实列表处理器提供隔离的索引与历史扫描依赖。 */
function createListHandler(indexed: boolean) {
  const sessions = Array.from({ length: 700 }, (_, index) => ({
    providerId: "codex", id: `session-${index}`, filePath: `/sessions/${index}.jsonl`,
    title: `Session ${index}`, date: 1000 - index, dirKey: "/workspace/project",
  }));
  const favorites = [sessions[650], sessions[680]].map((session) => ({ ...session, addedAt: 1 }));
  const listHistory = vi.fn(async (_project, options) => options.limit ? sessions.slice(0, options.limit) : sessions);
  const emptyRoots = async () => [];
  const handler = loadHistoryHandler("history.list", {
    ensureHistoryIndexLoaded: async () => {},
    getIndexedSummaries: () => indexed ? sessions : [],
    projects: { listProjectsFromStore: () => [{ wslPath: "/workspace/project" }] },
    settings: { getSettings: () => ({}) },
    deriveGeminiProjectHashCandidatesFromPath: () => [],
    extractGeminiProjectHashFromPath: () => "",
    createHistoryScopeMatcher,
    createHistoryFavoriteMatcher,
    listHistoryFavorites: () => favorites,
    selectCurrentHistorySummaries,
    findIndexedHistoryRecoveryTarget: () => undefined,
    requestHistoryListRecovery: () => false,
    history: { listHistory },
    getClaudeRootCandidatesFastAsync: emptyRoots,
    getGeminiRootCandidatesFastAsync: emptyRoots,
    getAntigravityRootCandidatesFastAsync: emptyRoots,
    getGrokRootCandidatesFastAsync: emptyRoots,
    perfLogger: { time: async (_label: string, action: () => Promise<unknown>) => action() },
  });
  return { handler, listHistory };
}

describe("历史收藏 IPC 集成", () => {
  it.each([
    [true, "all_sessions"], [true, "current_project"], [true, "project_group"],
    [false, "all_sessions"], [false, "current_project"], [false, "project_group"],
  ])("索引启用=%s、范围=%s：先过滤旧收藏再分页", async (indexed, scope) => {
    const { handler } = createListHandler(indexed as boolean);
    const args = { scope, projectWslPath: "/workspace/project", groupProjectWslPaths: ["/workspace/project"], favoritesOnly: true, limit: 1 };
    const first = await handler(null, args);
    const second = await handler(null, { ...args, offset: 1 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sessions.map((session: any) => session.id)).toEqual(["session-650"]);
    expect(second.sessions.map((session: any) => session.id)).toEqual(["session-680"]);
  });

  it("普通回退列表仍使用扫描预算，返回最新历史", async () => {
    const { handler, listHistory } = createListHandler(false);
    const result = await handler(null, { scope: "all_sessions", limit: 1 });
    expect(result.sessions.map((session: any) => session.id)).toEqual(["session-0"]);
    expect(listHistory.mock.calls[0][1].limit).toBe(33);
  });

  it("非法收藏开关不会写入存储", async () => {
    const save = vi.fn();
    const handler = loadHistoryHandler("history.setFavorite", { setHistoryFavorite: save });
    expect((await handler(null, { filePath: "/sessions/a.jsonl", favorite: "false" })).ok).toBe(false);
    expect((await handler(null, { favorite: true })).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
