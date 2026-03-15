import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGeminiSessionFile } from "./parser";

/**
 * 写入临时 Gemini session JSON 文件并返回其路径。
 *
 * @param obj 需要写入的 JSON 对象
 * @param filename 文件名
 * @returns 临时文件路径
 */
async function writeTempJson(obj: unknown, filename = `gemini-${Date.now()}-${Math.random().toString(16).slice(2)}.json`): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-"));
  const fp = path.join(dir, filename);
  await fs.promises.writeFile(fp, JSON.stringify(obj), "utf8");
  return fp;
}

/**
 * 在临时目录的指定相对路径写入 JSON 文件并返回文件路径。
 *
 * @param obj 需要写入的 JSON 对象
 * @param relPath 相对临时目录的目标路径
 * @returns 临时文件路径
 */
async function writeTempJsonAtRelPath(obj: unknown, relPath: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-"));
  const fp = path.join(dir, relPath);
  await fs.promises.mkdir(path.dirname(fp), { recursive: true });
  await fs.promises.writeFile(fp, JSON.stringify(obj), "utf8");
  return fp;
}

describe("parseGeminiSessionFile（超大文件 summaryOnly 预览兜底）", () => {
  it("当文件超过 maxBytes 时仍能从前缀提取 preview/sessionId/rawDate", async () => {
    const sessionId = "d3862d4d-7d74-46c4-9858-45cf754919ca";
    const startTime = "2026-01-30T16:39:19.465Z";
    const lastUpdated = "2026-01-30T17:05:47.475Z";

    const payload: any = {
      startTime,
      lastUpdated,
      sessionId,
      projectHash: "2c076481a534981f1d988b55053bccf053f1bec6932623a652d533211c63c763",
      messages: [
        {
          id: "m1",
          timestamp: startTime,
          type: "user",
          content: "`/mnt/c/Users/example-user/AppData/Roaming/codexflow/assets/CodexFlow/image-20260131-003734-k8xy.png`\n\n真实首条：你好",
        },
        {
          id: "m2",
          timestamp: lastUpdated,
          type: "gemini",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              name: "SearchText",
              result: "x".repeat(220 * 1024), // 制造足够大的文件，触发 maxBytes 保护分支
            },
          ],
        },
      ],
    };

    const fp = await writeTempJson(payload, `session-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const stat = await fs.promises.stat(fp);
    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 64 * 1024 });

    expect(details.preview).toBe("真实首条：你好");
    expect(details.title).toBe("真实首条：你好");
    expect(details.resumeId).toBe(sessionId);
    expect(details.rawDate).toBe(lastUpdated);
    expect(details.messages.length).toBe(0);
  });

  it("当路径不含 hash 目录时，仍可从 JSON 头部提取 projectHash", async () => {
    const projectHash = "567266847957ce43ba0e98d21b65cf333047f193f52e511da7be4fcbf53e53ba";
    const fp = await writeTempJsonAtRelPath(
      {
        sessionId: "cc28c19a-73b0-470a-b8cf-738ec6a547a8",
        projectHash,
        startTime: "2026-03-04T17:09:47.101Z",
        lastUpdated: "2026-03-04T17:09:55.680Z",
        messages: [
          { type: "user", content: [{ text: "hello gemini" }] },
          { type: "gemini", content: "你好！" },
        ],
      },
      `codexflow/chats/session-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    const stat = await fs.promises.stat(fp);
    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 128 * 1024 });

    expect(details.projectHash).toBe(projectHash);
    expect(details.preview).toBe("hello gemini");
    expect(details.resumeId).toBe("cc28c19a-73b0-470a-b8cf-738ec6a547a8");
  });
});

