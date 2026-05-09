// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { parseMergeFailure, parseSmartOperationProblem } from "./conflicts";

/**
 * 构造最小 Git 命令结果，供 Merge 失败分类测试复用。
 */
function createGitExecResult(stderr: string) {
  return {
    ok: false,
    stdout: "",
    stderr,
    exitCode: 1,
  };
}

describe("merge failure parsing", () => {
  it("应识别本地改动覆盖问题", () => {
    const failure = parseMergeFailure(createGitExecResult(`
error: Your local changes to the following files would be overwritten by merge:
  src/app.ts
Please, commit your changes or stash them before you can merge.
Aborting
    `));
    expect(failure.type).toBe("LOCAL_CHANGES");
    expect(failure.fileList?.files).toContain("src/app.ts");
    expect(failure.problem?.kind).toBe("local-changes-overwritten");
  });

  it("多行 Merge header 不应把 the following files 当作文件路径", () => {
    const failure = parseMergeFailure(createGitExecResult(`
error: Your local changes to the following files would be overwritten by merge:
  src/app.ts
Please, commit your changes or stash them before you can merge.
Aborting
    `));

    expect(failure.type).toBe("LOCAL_CHANGES");
    expect(failure.fileList?.files).toEqual(["src/app.ts"]);
    expect(failure.fileList?.files).not.toContain("the following files");
  });

  it("IDEA 同类 Merge footer 文案不应进入文件列表", () => {
    const failure = parseMergeFailure(createGitExecResult(`
error: Your local changes to the following files would be overwritten by merge:
  src/app.ts
Please commit your changes or stash them before you merge.
Aborting
    `));

    expect(failure.type).toBe("LOCAL_CHANGES");
    expect(failure.fileList?.files).toEqual(["src/app.ts"]);
    expect(failure.fileList?.files).not.toContain("Please commit your changes or stash them before you merge.");
  });

  it("旧版单行 Merge 报错仍应提取真实文件路径", () => {
    const failure = parseMergeFailure(createGitExecResult("error: Your local changes to 'src/legacy.ts' would be overwritten by merge."));

    expect(failure.type).toBe("LOCAL_CHANGES");
    expect(failure.fileList?.files).toEqual(["src/legacy.ts"]);
  });

  it("旧版单行多文件 Merge 报错应拆成多个真实路径", () => {
    const failure = parseMergeFailure(createGitExecResult(`
error: Your local changes to the following files would be overwritten by merge:
  src/app.ts src/other.ts
Please, commit your changes or stash them before you can merge.
Aborting
    `));

    expect(failure.type).toBe("LOCAL_CHANGES");
    expect(failure.fileList?.files).toEqual(["src/app.ts", "src/other.ts"]);
  });

  it("Merge 输出里的 <stdin> 噪声不应进入文件列表", () => {
    const failure = parseMergeFailure(createGitExecResult(`
error: Your local changes to the following files would be overwritten by merge:
  src/app.ts src/other.ts
<stdin>:7: trailing whitespace.
warning: 1 line adds whitespace errors.
Please, commit your changes or stash them before you can merge.
Aborting
    `));

    expect(failure.type).toBe("LOCAL_CHANGES");
    expect(failure.fileList?.files).toEqual(["src/app.ts", "src/other.ts"]);
    expect(failure.fileList?.files).not.toContain("<stdin>:7: trailing whitespace.");
  });

  it("应识别未跟踪文件覆盖问题", () => {
    const failure = parseMergeFailure(createGitExecResult(`
error: The following untracked working tree files would be overwritten by merge:
  src/new.ts
Please move or remove them before you merge.
Aborting
    `));
    expect(failure.type).toBe("UNTRACKED");
    expect(failure.fileList?.files).toEqual(["src/new.ts"]);
    expect(failure.problem?.kind).toBe("untracked-overwritten");
  });

  it("应识别普通 Merge 冲突", () => {
    const failure = parseMergeFailure(createGitExecResult("Automatic merge failed; fix conflicts and then commit the result."));
    expect(failure.type).toBe("CONFLICT");
    expect(failure.problem?.kind).toBe("merge-conflict");
  });

  it("无法归类时应回退为 OTHER", () => {
    const failure = parseMergeFailure(createGitExecResult("fatal: unknown merge error"));
    expect(failure.type).toBe("OTHER");
    expect(failure.message).toContain("unknown merge error");
  });

  it("Checkout header 不应把 the following files 当作文件路径", () => {
    const problem = parseSmartOperationProblem(createGitExecResult(`
error: Your local changes to the following files would be overwritten by checkout:
  src/app.ts
Please commit your changes or stash them before you switch branches.
Aborting
    `), "checkout");

    expect(problem?.kind).toBe("local-changes-overwritten");
    expect(problem?.files).toEqual(["src/app.ts"]);
    expect(problem?.files).not.toContain("the following files");
  });

  it("旧版单行 Checkout 报错仍应提取真实文件路径", () => {
    const problem = parseSmartOperationProblem(
      createGitExecResult("error: You have local changes to 'src/legacy.ts'; cannot switch branches."),
      "checkout",
    );

    expect(problem?.kind).toBe("local-changes-overwritten");
    expect(problem?.files).toEqual(["src/legacy.ts"]);
  });

  it("应识别 Cherry-pick 本地改动覆盖问题，并保留 Cherry-pick 操作语义", () => {
    const problem = parseSmartOperationProblem(createGitExecResult(`
error: Your local changes would be overwritten by cherry-pick.
hint: commit your changes or stash them to proceed.
fatal: cherry-pick failed
    `), "cherry-pick");

    expect(problem?.kind).toBe("local-changes-overwritten");
    expect(problem?.operation).toBe("cherry-pick");
  });

  it("Cherry-pick 单行文件报错仍应提取真实文件路径", () => {
    const problem = parseSmartOperationProblem(
      createGitExecResult("error: Your local changes to 'src/pick.ts' would be overwritten by cherry-pick."),
      "cherry-pick",
    );

    expect(problem?.kind).toBe("local-changes-overwritten");
    expect(problem?.files).toEqual(["src/pick.ts"]);
  });
});
