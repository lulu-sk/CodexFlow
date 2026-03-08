import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findNativeCodexInPath } from "./bridge";

describe("electron/codex/bridge（Codex CLI 定位）", () => {
  it("findNativeCodexInPath 在 macOS/Linux 语义下可从 PATH 定位 codex", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-bridge-"));
    try {
      const candidate = path.join(dir, "codex");
      fs.writeFileSync(candidate, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(candidate, 0o755);
      expect(findNativeCodexInPath(dir, "darwin")).toBe(candidate);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("findNativeCodexInPath 在 Windows 语义下返回 null", () => {
    expect(findNativeCodexInPath("C:\\tools", "win32")).toBeNull();
  });
});
