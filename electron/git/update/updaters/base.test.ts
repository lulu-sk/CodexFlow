// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it, vi } from "vitest";
import { handleUpdateCommandFailureAsync } from "./base";

describe("update finalize base", () => {
  it("进入未完成更新态时不应自动恢复本地改动，而应返回 kept-saved preservingState", async () => {
    const restoreLocalChangesAfterUpdateAsync = vi.fn();
    const runtime = {
      repoRoot: "/repo",
      restoreLocalChangesAfterUpdateAsync,
      notifyLocalChangesAreNotRestored(saved: { ref: string }) {
        return {
          saveChangesPolicy: "shelve" as const,
          status: "kept-saved" as const,
          localChangesRestorePolicy: "keep-saved" as const,
          savedLocalChangesRef: saved.ref,
          savedLocalChangesDisplayName: `搁置记录 ${saved.ref}`,
          message: "当前仓库已进入未完成更新状态，搁置记录尚未自动恢复。",
          notRestoredReason: "unfinished-state" as const,
        };
      },
      async detectIncompleteUpdateStateAsync(saved: { ref: string } | null) {
        return {
          code: "merge-in-progress" as const,
          stage: "update" as const,
          localChangesRestorePolicy: "keep-saved" as const,
          savedLocalChangesRef: saved?.ref,
          message: "Merge 仍在进行中",
        };
      },
      toGitErrorMessage() {
        return "更新项目失败";
      },
    };

    const result = await handleUpdateCommandFailureAsync(
      runtime,
      "更新项目失败",
      { ok: false, stdout: "", stderr: "merge failed", exitCode: 1 },
      {
        ref: "shelf@{demo}",
        message: "demo",
        saveChangesPolicy: "shelve",
        displayName: "搁置记录 shelf@{demo}",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.data?.resultCode).toBe("INCOMPLETE");
    expect(result.data?.preservingState?.status).toBe("kept-saved");
    expect(result.data?.preservingState?.notRestoredReason).toBe("unfinished-state");
    expect(restoreLocalChangesAfterUpdateAsync).not.toHaveBeenCalled();
  });
});
