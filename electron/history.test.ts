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

import { detectRuntimeShell, readHistoryFile } from "./history";

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
});

describe("electron/history.detectRuntimeShell", () => {
  it("Windows 下会把 POSIX 绝对路径识别为 WSL", () => {
    expect(detectRuntimeShell("/home/test/.codex/sessions/demo.jsonl", "win32")).toBe("wsl");
    expect(detectRuntimeShell("/var/tmp/demo.jsonl", "win32")).toBe("wsl");
  });

  it("macOS/Linux 下会把 POSIX 绝对路径识别为 native", () => {
    expect(detectRuntimeShell("/Users/test/.codex/sessions/demo.jsonl", "darwin")).toBe("native");
    expect(detectRuntimeShell("/home/test/.codex/sessions/demo.jsonl", "linux")).toBe("native");
  });
});
