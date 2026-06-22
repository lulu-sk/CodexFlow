import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAntigravitySessionFiles } from "./discovery";

/**
 * 在临时目录创建空文件。
 */
async function touch(root: string, name: string): Promise<void> {
  const fp = path.join(root, name);
  await fs.promises.writeFile(fp, "", "utf8");
}

describe("discoverAntigravitySessionFiles", () => {
  it("只发现 conversation DB，忽略 WAL/SHM 与其它文件", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-antigravity-discovery-"));
    await touch(root, "conversation-a.db");
    await touch(root, "conversation-a.db-wal");
    await touch(root, "conversation-a.db-shm");
    await touch(root, "notes.json");

    const files = await discoverAntigravitySessionFiles(root);
    const rel = files.map((f) => path.relative(root, f).replace(/\\/g, "/")).sort();

    expect(rel).toEqual(["conversation-a.db"]);
  });
});
