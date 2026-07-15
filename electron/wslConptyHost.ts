// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { WslConptyPty } from "./wslConpty.js";
import type {
  WslConptyHostCommand,
  WslConptyHostEvent,
} from "./wslConptyProtocol.js";

type UtilityParentPort = {
  postMessage(message: WslConptyHostEvent): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
};

const parentPort = (process as NodeJS.Process & {
  parentPort?: UtilityParentPort;
}).parentPort;

if (!parentPort)
  throw new Error("WSL PTY host parent port is unavailable");

let terminal: WslConptyPty | null = null;

/** 向 Electron 主进程发送一条 WSL PTY 宿主事件。 */
function postEvent(event: WslConptyHostEvent): void {
  parentPort.postMessage(event);
}

/** 把未知异常转换为可跨进程传递的错误文本。 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message)
    return error.message;
  return String(error || "unknown error");
}

/** 在独立工具进程中创建并接管一个 WSL ConPTY。 */
function initializeTerminal(command: Extract<WslConptyHostCommand, { type: "init" }>): void {
  if (terminal)
    return;
  try {
    const created = new WslConptyPty({
      file: command.file,
      args: command.args,
      ptyOptions: command.ptyOptions,
      frontendReadyTimeoutMs: command.frontendReadyTimeoutMs,
      onFallback: (reason) => postEvent({ type: "fallback", reason }),
      onDiagnostic: (message) => postEvent({ type: "diagnostic", message }),
    });
    terminal = created;
    created.onData((data) => postEvent({ type: "data", data }));
    created.onExit((event) => {
      postEvent({
        type: "exit",
        exitCode: event.exitCode,
        signal: event.signal,
      });
      terminal = null;
    });
    postEvent({
      type: "ready",
      pid: created.pid,
      cols: created.cols,
      rows: created.rows,
      process: created.process,
      handleFlowControl: created.handleFlowControl,
      backend: created.backend,
      fallbackReason: created.fallbackReason,
    });
  } catch (error) {
    postEvent({ type: "init-error", error: describeError(error) });
  }
}

/** 把主进程命令转发给当前工具进程持有的 WSL ConPTY。 */
function handleCommand(command: WslConptyHostCommand): void {
  if (command.type === "init") {
    initializeTerminal(command);
    return;
  }
  const current = terminal;
  if (!current)
    return;
  switch (command.type) {
    case "write":
      current.write(command.data);
      break;
    case "write-when-ready":
      current.writeWhenFrontendReady(command.data);
      break;
    case "frontend-ready":
      current.markFrontendReady(command.colors);
      break;
    case "resize":
      current.resize(command.columns, command.rows);
      break;
    case "clear":
      current.clear();
      break;
    case "kill":
      current.kill(command.signal);
      break;
    case "pause":
      current.pause();
      break;
    case "resume":
      current.resume();
      break;
    case "flow-control":
      current.handleFlowControl = command.enabled;
      break;
  }
}

parentPort.on("message", (event) => {
  try {
    handleCommand(event.data as WslConptyHostCommand);
  } catch (error) {
    postEvent({
      type: "diagnostic",
      message: `command-error ${describeError(error)}`,
    });
  }
});
