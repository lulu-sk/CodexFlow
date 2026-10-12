import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

let userDataDir = "";
const wslMockState = vi.hoisted(() => ({ sessionRoots: [] as string[] }));

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

vi.mock("./wsl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wsl")>();
  return {
    ...actual,
    getSessionsRootsFastAsync: vi.fn(async () => wslMockState.sessionRoots),
  };
});

import { listHistory, listHistorySplit, readHistoryFile } from "./history";

const tempDirs: string[] = [];

beforeEach(async () => {
  userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-user-data-"));
  tempDirs.push(userDataDir);
  wslMockState.sessionRoots = [];
});

/**
 * 中文说明：创建临时 Codex JSONL 历史文件，供解析回归测试使用。
 */
async function createHistoryJsonlFile(lines: unknown[]): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "rollout-test.jsonl");
  const body = lines.map((line) => JSON.stringify(line)).join("\n");
  await fsp.writeFile(filePath, `${body}\n`, "utf8");
  return filePath;
}

/**
 * 中文说明：创建符合 Codex sessions 年/月/日目录结构的临时历史文件，供列表扫描测试使用。
 */
async function createHistoryListJsonlFile(lines: unknown[]): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-root-"));
  tempDirs.push(root);
  const dir = path.join(root, "2026", "04", "29");
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "rollout-2026-04-29T03-35-01-test.jsonl");
  const body = lines.map((line) => JSON.stringify(line)).join("\n");
  await fsp.writeFile(filePath, `${body}\n`, "utf8");
  wslMockState.sessionRoots = [root];
  return filePath;
}

/**
 * 中文说明：在临时目录中创建一个图片文件占位，用于验证本地路径优先策略。
 */
async function createTempImageFile(fileName = "history-image.png"): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-image-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, fileName);
  await fsp.writeFile(filePath, "fake-image", "utf8");
  return filePath;
}

/**
 * 中文说明：将 Windows 临时图片路径转换为 `/mnt/<drive>/...` 形式，模拟真实 WSL 文本输入。
 */
function toWslImagePath(winPath: string): string {
  const normalized = String(winPath || "").replace(/\//g, "\\");
  const match = normalized.match(/^([A-Za-z]):\\(.*)$/);
  if (!match?.[1]) return normalized.replace(/\\/g, "/");
  return `/mnt/${match[1].toLowerCase()}/${String(match[2] || "").replace(/\\/g, "/")}`;
}

/**
 * 中文说明：将 Windows 路径规整为使用正斜杠的绝对路径，模拟 `view_image` 新日志参数。
 */
function toForwardSlashWindowsPath(winPath: string): string {
  return String(winPath || "").replace(/\\/g, "/");
}

/**
 * 中文说明：提取解析结果中的全部文本片段，便于断言尾部消息是否被完整保留。
 */
function collectTexts(messages: Array<{ content?: Array<{ text?: string }> }>): string[] {
  const out: string[] = [];
  for (const message of messages || []) {
    for (const item of message?.content || []) {
      const text = String(item?.text || "");
      if (text) out.push(text);
    }
  }
  return out;
}

afterEach(async () => {
  delete (global as any).__historyCache;
  delete (global as any).__historySummaryCache;
  userDataDir = "";
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {}
  }));
});

describe("electron/history.listHistory", () => {
  it("扫描和缓存分页都能匹配 Windows 的 new-chat 子目录", async () => {
    const cwd = "C:\\workspace\\daily\\new-chat";
    await createHistoryListJsonlFile([
      { type: "session_meta", payload: { id: "windows-new-chat", cwd } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "测试请求" }] } },
    ]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessions = await listHistory({ winPath: cwd, wslPath: "/mnt/c/workspace/daily/new-chat" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].dirKey).toBe("/mnt/c/workspace/daily/new-chat");
    }
    expect(await listHistory({ winPath: "C:\\workspace\\dailyew-chat" })).toHaveLength(0);
  });

  it("回退多版本在扫描和缓存分页中只保留当前版本，详情恢复继承记录", async () => {
    const thread = "11111111-1111-4111-8111-111111111111";
    const revision = "22222222-2222-4222-8222-222222222222";
    const prefixRecords = [
      { ordinal: 0, type: "session_meta", payload: { id: thread, cwd: "/workspace/project" } },
      { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "保留的请求" }] } },
      { ordinal: 2, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "保留的回答" }] } },
    ];
    const obsolete = { ordinal: 3, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "已撤回的请求" }] } };
    const initialPath = await createHistoryListJsonlFile([...prefixRecords, obsolete]);
    const originalPath = path.join(path.dirname(initialPath), `rollout-2026-04-29T03-35-01-${thread}.jsonl`);
    await fsp.rename(initialPath, originalPath);
    const revisionPath = path.join(path.dirname(originalPath), `rollout-2026-04-29T03-36-01-${thread}_${revision}.jsonl`);
    const prefix = prefixRecords.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await fsp.writeFile(revisionPath, [
      JSON.stringify({ ordinal: 3, type: "session_meta", payload: { id: thread, cwd: "/workspace/project", history_base: { thread_id: thread, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix) } } }),
      JSON.stringify({ ...obsolete, payload: { ...obsolete.payload, content: [{ type: "input_text", text: "修改后的请求" }] } }),
    ].join("\n") + "\n", "utf8");
    await fsp.utimes(originalPath, new Date(), new Date(Date.now() + 10_000));

    for (let attempt = 0; attempt < 2; attempt++) {
      const sessions = await listHistory({}, { limit: 1 });
      expect(sessions.map((item) => item.filePath)).toEqual([revisionPath]);
      expect(await listHistory({}, { offset: 1, limit: 1 })).toEqual([]);
    }
    expect((await listHistorySplit({})).all.map((item) => item.filePath)).toEqual([revisionPath]);
    const details = await readHistoryFile(revisionPath, { maxLines: 0 });
    expect(details.id).toBe(thread);
    const texts = collectTexts(details.messages);
    expect(texts).toContain("保留的请求");
    expect(texts).toContain("保留的回答");
    expect(texts).toContain("修改后的请求");
    expect(texts).not.toContain("已撤回的请求");
  });

  it("列表摘要会携带现代 Codex 子代理关系", async () => {
    await createHistoryListJsonlFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "child-session",
          cwd: "/workspace/project",
          parent_thread_id: "parent-session",
          agent_nickname: "Atlas",
          agent_role: "researcher",
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: "parent-session", depth: 1 },
            },
          },
        },
      },
    ]);

    const sessions = await listHistory({});

    expect(sessions).toHaveLength(1);
    expect(sessions[0].codexRelationship).toMatchObject({
      kind: "subagent",
      parentThreadId: "parent-session",
      agentNickname: "Atlas",
      agentRole: "researcher",
      agentDepth: 1,
    });
  });

  it("列表摘要优先使用 Codex thread_name_updated 作为预览标题", async () => {
    const userRequest = [
      "# Files mentioned by the user:",
      "",
      "## workflows/alp-auto-current-ops.json",
      "",
      "## My request for Codex:",
      "工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距",
    ].join("\n");
    const largeImage = `data:image/png;base64,${"a".repeat(96 * 1024)}`;
    await createHistoryListJsonlFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-thread-name",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: userRequest },
            { type: "input_image", image_url: largeImage },
          ],
        },
      },
      {
        timestamp: "2026-04-29T03:35:08.000Z",
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_id: "session-thread-name",
          thread_name: "优化 alp-auto-current-ops 节点布局",
        },
      },
    ]);

    const sessions = await listHistory({});

    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("优化 alp-auto-current-ops 节点布局");
    expect(sessions[0].preview).toBe("优化 alp-auto-current-ops 节点布局");
  });

  it("没有线程名时会从 Files mentioned 模板中提取真实请求", async () => {
    await createHistoryListJsonlFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-clean-request",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "# Files mentioned by the user:",
                "",
                "## workflows/alp-auto-current-ops.json",
                "",
                "## My request for Codex:",
                "工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距",
              ].join("\n"),
            },
          ],
        },
      },
    ]);

    const sessions = await listHistory({});

    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距");
    expect(sessions[0].preview).toBe("工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距");
    expect(sessions[0].preview || "").not.toContain("# Files mentioned by the user");
  });

  it("goal 内部上下文不会被当成标题，并继续跳过前置路径行", async () => {
    await createHistoryListJsonlFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-goal-context",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<codex_internal_context source=\"goal\">",
                "内部目标上下文不应作为标题",
                "</codex_internal_context>",
                "src/features/history/detail.ts",
                "修复历史详情标题提取",
              ].join("\n"),
            },
          ],
        },
      },
    ]);

    const sessions = await listHistory({});

    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("修复历史详情标题提取");
    expect(sessions[0].preview).toBe("修复历史详情标题提取");
  });

  it("goal objective 可作为首条标题候选且 turn_aborted 不会抢占标题", async () => {
    await createHistoryListJsonlFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-goal-objective",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<codex_internal_context source=\"goal\">",
                "Continue working toward the active thread goal.",
                "<objective>",
                "你作为调度者，最终目标是完整推进测试与验收工作",
                "`alp-auto-v3-lan-three-task-test.zh-CN.md`",
                "</objective>",
                "</codex_internal_context>",
              ].join("\n"),
            },
          ],
        },
      },
      {
        timestamp: "2026-04-29T03:35:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<turn_aborted>",
                "The user interrupted the previous turn on purpose.",
                "</turn_aborted>",
              ].join("\n"),
            },
          ],
        },
      },
      {
        timestamp: "2026-04-29T03:35:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "预检我不是提醒你了吗，只执行一个任务就行" }],
        },
      },
    ]);

    const sessions = await listHistory({});

    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("你作为调度者，最终目标是完整推进测试与验收工作");
    expect(sessions[0].preview).toBe("你作为调度者，最终目标是完整推进测试与验收工作");
  });
});

describe("electron/history.readHistoryFile", () => {
  it("将不带 for 后缀的 AGENTS.md instructions 解析为说明分类", async () => {
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-06T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-agents-instructions",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-03-06T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n规则内容\n</INSTRUCTIONS>",
            },
          ],
        },
      },
      {
        timestamp: "2026-03-06T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "真正的用户问题" }],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const instructionItem = parsed.messages
      .flatMap((message) => message.content || [])
      .find((item) => item.type === "instructions");
    const allTexts = collectTexts(parsed.messages);

    expect(instructionItem?.text).toBe("\n规则内容\n");
    expect(allTexts).not.toContain("# AGENTS.md instructions\n\n<INSTRUCTIONS>\n规则内容\n</INSTRUCTIONS>");
    expect(allTexts).toContain("真正的用户问题");
  });

  it("将 subagent_notification 解析为通知消息并格式化换行", async () => {
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-06T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-subagent-notification",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-03-06T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<subagent_notification>",
                "{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"第一行\\n\\n第二行\"}}",
                "</subagent_notification>",
              ].join("\n"),
            },
          ],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const notification = parsed.messages.find((message) => message.content?.some((item) => item.type === "subagent_notification"));
    const text = notification?.content?.find((item) => item.type === "subagent_notification")?.text || "";

    expect(notification?.role).toBe("notification");
    expect(text).toContain("agent_path: agent-1");
    expect(text).toContain("completed:");
    expect(text).toContain("第一行");
    expect(text).toContain("第二行");
    expect(text).not.toContain("\\n");
  });

  it("maxLines<=0 时会读取 5000 行之后的 response_item.output_text", async () => {
    const filePath = await createHistoryJsonlFile([
      {
        id: "session-late-output",
        timestamp: "2026-03-06T00:00:00.000Z",
        title: "late-output",
      },
      ...Array.from({ length: 5005 }, (_, index) => ({
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: `thinking-${index}` }],
        },
      })),
      {
        timestamp: "2026-03-06T09:14:24.551Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "**交接总览**\n这是一条位于 5000 行之后的 assistant 输出。",
            },
          ],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const allTexts = collectTexts(parsed.messages);

    expect(allTexts.some((text) => text.includes("5000 行之后"))).toBe(true);
  });

  it("完整读取不会被先前的受限缓存截断", async () => {
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-06T09:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-1",
          instructions: "system prompt",
        },
      },
      {
        timestamp: "2026-03-06T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "第一条输入" }],
        },
      },
      {
        timestamp: "2026-03-06T09:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "第一条输出" }],
        },
      },
      {
        timestamp: "2026-03-06T09:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "第二条输入" }],
        },
      },
      {
        timestamp: "2026-03-06T09:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "**交接总览**\n尾部消息必须可见" }],
        },
      },
    ]);

    const limited = await readHistoryFile(filePath, { maxLines: 3 });
    expect(collectTexts(limited.messages).some((text) => text.includes("尾部消息必须可见"))).toBe(false);

    const full = await readHistoryFile(filePath, { maxLines: 0 });
    expect(collectTexts(full.messages).some((text) => text.includes("尾部消息必须可见"))).toBe(true);
  });

  it("会优先恢复 Codex 历史中的本地图片路径，并保留 data URL 回退", async () => {
    const localImagePath = await createTempImageFile();
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-17T03:57:01.021Z",
        type: "session_meta",
        payload: {
          id: "session-image",
          cwd: "/tmp/demo",
        },
      },
      {
        timestamp: "2026-03-17T03:57:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `请查看这张图片：${localImagePath}` }],
        },
      },
      {
        timestamp: "2026-03-17T03:57:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-image",
          output: [{ type: "input_image", image_url: dataUrl }],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const imageItem = parsed.messages
      .flatMap((message) => message.content || [])
      .find((item) => item.type === "image");

    expect(imageItem).toBeTruthy();
    expect(imageItem?.localPath).toBe(localImagePath);
    expect(String(imageItem?.src || "")).toMatch(/^file:\/\//);
    expect(imageItem?.fallbackSrc).toBe(dataUrl);
    expect(String(imageItem?.text || "")).toContain(localImagePath);
  });

  it("连续多个 view_image 输出会按各自 call_id 恢复对应的本地图片路径", async () => {
    const localImagePathA = await createTempImageFile("history-image-a.png");
    const localImagePathB = await createTempImageFile("history-image-b.png");
    const localImagePathC = await createTempImageFile("history-image-c.png");
    const dataUrlA = "data:image/png;base64,QUFB";
    const dataUrlB = "data:image/png;base64,QkJC";
    const dataUrlC = "data:image/png;base64,Q0ND";
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-17T04:10:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-image-multi",
          cwd: "/tmp/demo",
        },
      },
      {
        timestamp: "2026-03-17T04:10:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "view_image",
          arguments: JSON.stringify({ path: localImagePathA }),
          call_id: "call-image-a",
        },
      },
      {
        timestamp: "2026-03-17T04:10:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "view_image",
          arguments: JSON.stringify({ path: localImagePathB }),
          call_id: "call-image-b",
        },
      },
      {
        timestamp: "2026-03-17T04:10:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "view_image",
          arguments: JSON.stringify({ path: localImagePathC }),
          call_id: "call-image-c",
        },
      },
      {
        timestamp: "2026-03-17T04:10:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-image-a",
          output: [{ type: "input_image", image_url: dataUrlA }],
        },
      },
      {
        timestamp: "2026-03-17T04:10:05.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-image-b",
          output: [{ type: "input_image", image_url: dataUrlB }],
        },
      },
      {
        timestamp: "2026-03-17T04:10:06.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-image-c",
          output: [{ type: "input_image", image_url: dataUrlC }],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const recoveredImageItems = parsed.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content || [])
      .filter((item) => item.type === "image" && String(item.fallbackSrc || "").startsWith("data:image/"));

    expect(recoveredImageItems).toHaveLength(3);
    expect(recoveredImageItems.map((item) => item.localPath)).toEqual([
      localImagePathA,
      localImagePathB,
      localImagePathC,
    ]);
    expect(recoveredImageItems.map((item) => item.fallbackSrc)).toEqual([
      dataUrlA,
      dataUrlB,
      dataUrlC,
    ]);
  });

  it("新版 custom_tool_call_output 会按图片顺序恢复缺失路径对应的会话图片", async () => {
    const localImagePathA = "C:\\workspace\\fixtures\\missing-image-a.png";
    const localImagePathB = "C:\\workspace\\fixtures\\missing-image-b.png";
    const dataUrlA = "data:image/png;base64,QUFB";
    const dataUrlB = "data:image/png;base64,QkJC";
    const callId = "call-custom-image-output";
    const escapedImagePathA = localImagePathA.replace(/\\/g, "\\\\");
    const escapedImagePathB = localImagePathB.replace(/\\/g, "\\\\");
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-07-21T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-custom-image-output",
          cwd: "C:\\workspace\\project",
        },
      },
      {
        timestamp: "2026-07-21T01:00:01.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: callId,
          name: "exec",
          input: `Get-Item -LiteralPath 'C:\\\\workspace\\\\fixtures\\\\notes.txt','${escapedImagePathA}','${escapedImagePathB}'`,
        },
      },
      {
        timestamp: "2026-07-21T01:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: callId,
          output: [
            { type: "input_text", text: "工具调用已完成" },
            { type: "input_image", image_url: dataUrlA },
            { type: "input_image", image_url: dataUrlB },
          ],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const imageItems = parsed.messages
      .flatMap((message) => message.content || [])
      .filter((item) => item.type === "image");
    const normalizedLocalPaths = imageItems.map((item) => String(item.localPath || "").replace(/\\+/g, "\\"));

    expect(imageItems).toHaveLength(2);
    expect(normalizedLocalPaths).toEqual([localImagePathA, localImagePathB]);
    expect(imageItems.map((item) => item.src)).toEqual([dataUrlA, dataUrlB]);
    expect(collectTexts(parsed.messages).join("\n")).not.toContain("base64,QUFB");
    expect(collectTexts(parsed.messages).join("\n")).not.toContain("base64,QkJC");
  });

  it("会把重复的 event_msg.user_message 合并到上一条等价 user 消息，避免详情块重复", async () => {
    const localImagePath = await createTempImageFile("history-image-merged.png");
    const wslImagePath = toWslImagePath(localImagePath);
    const messageText = `请查看图片：${wslImagePath}\n然后继续分析`;
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-25T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-user-merge",
          cwd: "/tmp/demo",
        },
      },
      {
        timestamp: "2026-03-25T01:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: messageText }],
        },
      },
      {
        timestamp: "2026-03-25T01:00:01.100Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: messageText,
          images: [],
          local_images: [],
          text_elements: [],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const userMessages = parsed.messages.filter((message) => message.role === "user");

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content?.map((item) => item.type)).toEqual(["input_text", "image"]);
    expect(userMessages[0]?.content?.[1]?.localPath).toBe(wslImagePath);
    expect(String(userMessages[0]?.content?.[1]?.src || "")).toMatch(/^file:\/\//);
  });

  it("会把 Codex 的 turn_diff 事件保留为可审核的历史内容", async () => {
    const unifiedDiff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-25T01:03:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-turn-diff",
          cwd: "/tmp/demo",
        },
      },
      {
        timestamp: "2026-03-25T01:03:01.000Z",
        type: "event_msg",
        payload: {
          type: "turn_diff",
          unified_diff: unifiedDiff,
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const changeMessage = parsed.messages.find((message) => message.role === "change");

    expect(changeMessage?.content).toMatchObject([{
      type: "turn_diff",
      text: unifiedDiff,
      tags: ["event_msg.turn_diff", "turn_diff"],
      cwd: "/tmp/demo",
      diffSource: "turn_diff",
      patchable: true,
    }]);
  });

  it("会把同一轮的改动卡片稳定放到该轮最后一条消息之后", async () => {
    const unifiedDiff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const turnId = "turn-order";
    const filePath = await createHistoryJsonlFile([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "先说明改动范围" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "turn_diff",
          unified_diff: unifiedDiff,
          turn_id: turnId,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "改动已完成" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "下一步" }],
          internal_chat_message_metadata_passthrough: { turn_id: "next-turn" },
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });

    expect(parsed.messages.map((message) => message.role)).toEqual(["assistant", "assistant", "change", "user"]);
  });

  it("缺少 turn_diff 时会按轮次合并 exec 中的 apply_patch 记录", async () => {
    const firstPatch = [
      "*** Begin Patch",
      "*** Update File: src/first.ts",
      "@@",
      "-export const first = 1;",
      "+export const first = 2;",
      "*** End Patch",
    ].join("\n");
    const secondPatch = [
      "*** Begin Patch",
      "*** Update File: src/second.ts",
      "@@",
      "-export const second = 1;",
      "+export const second = 2;",
      "*** End Patch",
    ].join("\n");
    const turnMetadata = { turn_id: "turn-apply-patch" };
    const filePath = await createHistoryJsonlFile([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-first",
          input: `const patch = ${JSON.stringify(firstPatch)}; text(await tools.apply_patch(patch));`,
          internal_chat_message_metadata_passthrough: turnMetadata,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-second",
          input: `const patch = ${JSON.stringify(secondPatch)}; text(await tools.apply_patch(patch));`,
          internal_chat_message_metadata_passthrough: turnMetadata,
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const changeMessages = parsed.messages.filter((message) => message.role === "change");

    expect(changeMessages).toHaveLength(1);
    expect(changeMessages[0]?.content?.[0]?.tags).toEqual([
      "custom_tool_call.apply_patch",
      "apply_patch",
      "turn_diff",
    ]);
    expect(changeMessages[0]?.content?.[0]?.text).toContain("*** Update File: src/first.ts");
    expect(changeMessages[0]?.content?.[0]?.text).toContain("*** Update File: src/second.ts");
  });

  it("会以 FileChange 作为改动摘要来源，并保留插件一致的原始差异段", async () => {
    const turnId = "turn-file-change";
    const firstBatch = {
      "C:\\workspace\\project\\Client\\Packages\\manifest.json": {
        type: "update",
        unified_diff: "@@ -1,1 +1,2 @@\n-old\n+new\n+another\n",
      },
      "C:\\workspace\\project\\Client\\Packages\\packages-lock.json": {
        type: "update",
        unified_diff: "@@ -4,2 +4,3 @@\n-before\n+after\n+added\n",
      },
      "C:\\workspace\\project\\Client\\Packages\\Coplay\\.gitignore": {
        type: "update",
        unified_diff: "@@ -1,1 +1,1 @@\n-old-ignore\n+new-ignore\n",
      },
      "C:\\workspace\\project_peer\\Client\\Packages\\manifest.json": {
        type: "update",
        unified_diff: "@@ -2,1 +2,2 @@\n-old-peer\n+new-peer\n+peer-extra\n",
      },
      "C:\\workspace\\project_peer\\Client\\Packages\\packages-lock.json": {
        type: "update",
        unified_diff: "@@ -3,1 +3,2 @@\n-old-lock\n+new-lock\n+lock-extra\n",
      },
      "C:\\workspace\\project_peer\\Client\\Packages\\Coplay\\.gitignore": {
        type: "update",
        unified_diff: "@@ -1,1 +1,1 @@\n-old-peer-ignore\n+new-peer-ignore\n",
      },
    };
    const filePath = await createHistoryJsonlFile([
      {
        type: "session_meta",
        payload: { id: "session-file-change", cwd: "C:\\workspace\\project" },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-fallback",
          input: "*** Begin Patch\n*** Update File: Client/Packages/manifest.json\n-old\n+new\n*** End Patch",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: { type: "CommandExecution", id: "command-project-1", cwd: "file:///C:/workspace/project" },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: { type: "FileChange", id: "file-change-1", changes: firstBatch },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: { type: "CommandExecution", id: "command-peer-1", cwd: "file:///C:/workspace/project_peer" },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-change-2",
            changes: {
              "C:\\workspace\\project_peer\\Client\\Packages\\packages-lock.json": {
                type: "update",
                unified_diff: "@@ -20,1 +20,2 @@\n-before-second\n+after-second\n+added-second\n",
              },
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: { type: "CommandExecution", id: "command-project-2", cwd: "file:///C:/workspace/project" },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-change-3",
            changes: {
              "C:\\workspace\\project\\Client\\Packages\\Coplay\\.gitignore": {
                type: "update",
                unified_diff: "@@ -1,1 +1,1 @@\n-new-ignore\n+localized-ignore\n",
              },
              "C:\\workspace\\project_peer\\Client\\Packages\\Coplay\\.gitignore": {
                type: "update",
                unified_diff: "@@ -1,1 +1,1 @@\n-new-peer-ignore\n+localized-peer-ignore\n",
              },
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-change-4",
            changes: {
              "C:\\workspace\\project\\Client\\Temp\\temporary.ps1": {
                type: "add",
                content: "one\ntwo\nthree\n",
              },
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-change-5",
            changes: {
              "C:\\workspace\\project\\Client\\Temp\\temporary.ps1": {
                type: "update",
                unified_diff: "@@ -1,2 +1,1 @@\n-one\n-two\n+merged\n",
              },
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: { type: "CommandExecution", id: "command-peer-2", cwd: "file:///C:/workspace/project_peer" },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-change-6",
            changes: {
              "C:\\workspace\\project\\Client\\Temp\\temporary.ps1": {
                type: "delete",
                content: "merged\n",
              },
            },
          },
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const changeMessages = parsed.messages.filter((message) => message.role === "change");
    const change = changeMessages[0]?.content?.[0];

    expect(changeMessages).toHaveLength(1);
    expect(change?.diffSource).toBe("file_change");
    expect(change?.patchable).toBe(false);
    expect(change?.cwd).toBe("C:\\workspace\\project");
    expect(change?.text).not.toContain("*** Begin Patch");
    const diffHeaders = change?.text.match(/^diff --git .+$/gm) || [];
    expect(diffHeaders).toEqual([
      "diff --git a/C:/workspace/project/Client/Packages/Coplay/.gitignore b/C:/workspace/project/Client/Packages/Coplay/.gitignore",
      "diff --git a/C:/workspace/project/Client/Packages/manifest.json b/C:/workspace/project/Client/Packages/manifest.json",
      "diff --git a/C:/workspace/project/Client/Packages/packages-lock.json b/C:/workspace/project/Client/Packages/packages-lock.json",
      "diff --git a/C:/workspace/project_peer/Client/Packages/Coplay/.gitignore b/C:/workspace/project_peer/Client/Packages/Coplay/.gitignore",
      "diff --git a/C:/workspace/project_peer/Client/Packages/manifest.json b/C:/workspace/project_peer/Client/Packages/manifest.json",
      "diff --git a/C:/workspace/project_peer/Client/Packages/packages-lock.json b/C:/workspace/project_peer/Client/Packages/packages-lock.json",
      "diff --git a/C:/workspace/project_peer/Client/Packages/packages-lock.json b/C:/workspace/project_peer/Client/Packages/packages-lock.json",
      "diff --git a/C:/workspace/project/Client/Temp/temporary.ps1 b/C:/workspace/project/Client/Temp/temporary.ps1",
      "diff --git a/C:/workspace/project/Client/Temp/temporary.ps1 b/C:/workspace/project/Client/Temp/temporary.ps1",
      "diff --git a/C:/workspace/project/Client/Temp/temporary.ps1 b/C:/workspace/project/Client/Temp/temporary.ps1",
    ]);
    const reviewSegments = String(change?.text || "").split(/(?=^diff --git )/m).filter(Boolean);
    expect((reviewSegments[0]?.match(/^@@/gm) || [])).toHaveLength(2);
    expect((reviewSegments[3]?.match(/^@@/gm) || [])).toHaveLength(2);
    expect(reviewSegments[7]).toContain("new file mode 100644");
    expect(reviewSegments[8]).not.toContain("new file mode 100644");
    expect(reviewSegments[9]).toContain("deleted file mode 100644");
  });

  it("移动操作会保持独立差异段，并切断同路径普通更新的合并", async () => {
    const turnId = "turn-file-move";
    const sourcePath = "C:\\workspace\\project\\src\\before.ts";
    const filePath = await createHistoryJsonlFile([
      { type: "session_meta", payload: { id: "session-file-move", cwd: "C:\\workspace\\project" } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-update-before-move",
            changes: { [sourcePath]: { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+updated\n" } },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-move",
            changes: {
              [sourcePath]: {
                type: "update",
                move_path: "C:\\workspace\\project\\src\\after.ts",
                unified_diff: "@@ -1 +1 @@\n-updated\n+moved\n",
              },
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "file-update-after-move",
            changes: { [sourcePath]: { type: "update", unified_diff: "@@ -1 +1 @@\n-moved\n+final\n" } },
          },
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const change = parsed.messages.find((message) => message.role === "change")?.content?.[0];
    const reviewSegments = String(change?.text || "").split(/(?=^diff --git )/m).filter(Boolean);

    expect(reviewSegments).toHaveLength(3);
    expect(reviewSegments[1]).toContain("rename from C:/workspace/project/src/before.ts");
    expect(reviewSegments[1]).toContain("rename to C:/workspace/project/src/after.ts");
  });

  it("标准 turn_diff 始终优先于同轮 FileChange 和 apply_patch 回退", async () => {
    const turnId = "turn-diff-priority";
    const standardDiff = [
      "diff --git a/src/standard.ts b/src/standard.ts",
      "--- a/src/standard.ts",
      "+++ b/src/standard.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");
    const filePath = await createHistoryJsonlFile([
      { type: "session_meta", payload: { id: "session-diff-priority", cwd: "C:\\workspace\\project" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "priority-patch",
          input: "*** Begin Patch\n*** Update File: src/fallback.ts\n-old\n+new\n*** End Patch",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "priority-file-change-before",
            changes: {
              "C:\\workspace\\project\\src\\fallback.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new\n" },
            },
          },
        },
      },
      { type: "event_msg", payload: { type: "turn_diff", turn_id: turnId, unified_diff: standardDiff } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "FileChange",
            id: "priority-file-change-after",
            changes: {
              "C:\\workspace\\project\\src\\ignored.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+ignored\n" },
            },
          },
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const changeMessages = parsed.messages.filter((message) => message.role === "change");
    const change = changeMessages[0]?.content?.[0];

    expect(changeMessages).toHaveLength(1);
    expect(change).toMatchObject({ text: standardDiff, diffSource: "turn_diff", patchable: true });
  });

  it("会清理 Codex 新格式用户消息中的图片边界占位符", async () => {
    const dataUrlA = "data:image/png;base64,QUFB";
    const dataUrlB = "data:image/png;base64,QkJC";
    const messageText = "请结合这些截图调整布局";
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-25T01:05:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-user-inline-images",
          cwd: "/tmp/demo",
        },
      },
      {
        timestamp: "2026-03-25T01:05:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: messageText },
            { type: "input_text", text: "<image>" },
            { type: "input_image", image_url: dataUrlA },
            { type: "input_text", text: "</image>" },
            { type: "input_text", text: "<image>" },
            { type: "input_image", image_url: dataUrlB },
            { type: "input_text", text: "</image>" },
          ],
        },
      },
      {
        timestamp: "2026-03-25T01:05:01.100Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: messageText,
          images: [dataUrlA, dataUrlB],
          local_images: [],
          text_elements: [],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const userMessages = parsed.messages.filter((message) => message.role === "user");
    const content = userMessages[0]?.content || [];

    expect(userMessages).toHaveLength(1);
    expect(content.map((item) => item.type)).toEqual(["input_text", "image", "image"]);
    expect(content.map((item) => item.text).join("\n")).not.toContain("<image>");
    expect(parsed.messages.some((message) => message.role === "event_msg")).toBe(false);
  });

  it("view_image 参数使用正斜杠 Windows 路径时会保留完整盘符路径", async () => {
    const localImagePath = await createTempImageFile("history-image-forward-slash.png");
    const forwardSlashPath = toForwardSlashWindowsPath(localImagePath);
    const dataUrl = "data:image/png;base64,Zm9yd2FyZA==";
    const filePath = await createHistoryJsonlFile([
      {
        timestamp: "2026-03-25T01:10:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-image-forward-slash",
          cwd: "/tmp/demo",
        },
      },
      {
        timestamp: "2026-03-25T01:10:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "view_image",
          arguments: JSON.stringify({ path: forwardSlashPath }),
          call_id: "call-forward-slash-image",
        },
      },
      {
        timestamp: "2026-03-25T01:10:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-forward-slash-image",
          output: [{ type: "input_image", image_url: dataUrl }],
        },
      },
    ]);

    const parsed = await readHistoryFile(filePath, { maxLines: 0 });
    const imageItem = parsed.messages
      .flatMap((message) => message.content || [])
      .find((item) => item.type === "image" && String(item.fallbackSrc || "").startsWith("data:image/"));

    expect(imageItem).toBeTruthy();
    expect(imageItem?.localPath).toBe(forwardSlashPath);
  });
});
