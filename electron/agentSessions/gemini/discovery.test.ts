import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverGeminiSessionFiles } from "./discovery";

/**
 * 在临时目录中创建文件（自动创建父目录）。
 *
 * @param root 临时根目录
 * @param relPath 相对路径
 */
async function touch(root: string, relPath: string): Promise<void> {
  const fp = path.join(root, relPath);
  await fs.promises.mkdir(path.dirname(fp), { recursive: true });
  await fs.promises.writeFile(fp, "{}", "utf8");
}

describe("discoverGeminiSessionFiles", () => {
  it("supports both hash and non-hash project directories", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-discovery-"));

    await touch(root, "codexflow/chats/session-2026-03-04T17-09-cc28c19a.json");
    await touch(root, "567266847957ce43ba0e98d21b65cf333047f193f52e511da7be4fcbf53e53ba/chats/session-2026-03-04T17-10-aabbccdd.json");
    await touch(root, "codexflow/chats/ignore.txt");

    const files = await discoverGeminiSessionFiles(root);
    const rel = files.map((f) => path.relative(root, f).replace(/\\/g, "/")).sort();

    expect(rel).toContain("codexflow/chats/session-2026-03-04T17-09-cc28c19a.json");
    expect(rel).toContain("567266847957ce43ba0e98d21b65cf333047f193f52e511da7be4fcbf53e53ba/chats/session-2026-03-04T17-10-aabbccdd.json");
    expect(rel.find((x) => x.endsWith("ignore.txt"))).toBeUndefined();
  });
});

