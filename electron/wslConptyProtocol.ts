// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { IWindowsPtyForkOptions } from "node-pty";
import type {
  TerminalPaletteColors,
  WslConptyBackend,
} from "./wslConpty.js";

export type WslConptyHostCommand =
  | {
      type: "init";
      file: string;
      args: string[];
      ptyOptions: IWindowsPtyForkOptions;
      frontendReadyTimeoutMs?: number;
    }
  | { type: "write"; data: string }
  | { type: "write-when-ready"; data: string }
  | { type: "frontend-ready"; colors?: Partial<TerminalPaletteColors> }
  | { type: "resize"; columns: number; rows: number }
  | { type: "clear" }
  | { type: "kill"; signal?: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "flow-control"; enabled: boolean };

export type WslConptyHostEvent =
  | {
      type: "ready";
      pid: number;
      cols: number;
      rows: number;
      process: string;
      handleFlowControl: boolean;
      backend: WslConptyBackend;
      fallbackReason?: string;
    }
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "fallback"; reason: string }
  | { type: "diagnostic"; message: string }
  | { type: "init-error"; error: string };
