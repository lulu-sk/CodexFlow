import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

let userDataDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

import { readHistoryFile } from "./history";

const tempDirs: string[] = [];

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
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {}
  }));
});

describe("electron/history.readHistoryFile", () => {
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
