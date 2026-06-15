import { describe, expect, it, vi } from 'vitest';

vi.mock('@lydell/node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('./settings.js', () => ({
  default: {
    getSettings: () => ({ terminal: 'pwsh' }),
  },
}));

vi.mock('./debugConfig.js', () => ({
  getDebugConfig: () => ({ terminal: { pty: { debug: false } } }),
}));

vi.mock('./log.js', () => ({
  perfLogger: { log: vi.fn() },
}));

import { PTYManager } from './pty';

describe('PTYManager', () => {
  /**
   * 创建带可观察 IPC 发送能力的窗口桩。
   */
  function createWindowStub() {
    const send = vi.fn();
    return {
      send,
      win: {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          mainFrame: {
            isDestroyed: () => false,
            send,
          },
        },
      },
    };
  }

  it('resize 遇到底层已退出 PTY 异常时应清理 session、发送尾部输出并通知前端退出', () => {
    const { send, win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const resize = vi.fn(() => {
      throw new Error('Cannot resize a pty that has already exited');
    });

    (manager as any).sessions.set('pty-exited', { resize });
    (manager as any).backlogs.set('pty-exited', { clear: vi.fn() });
    (manager as any).ipcPendingById.set('pty-exited', {
      timer: null,
      chunks: ['tail output'],
      totalChars: 'tail output'.length,
      droppedChars: 0,
    });

    expect(() => manager.resize('pty-exited', 120, 30)).not.toThrow();
    expect(resize).toHaveBeenCalledWith(120, 30);
    expect(manager.hasSession('pty-exited')).toBe(false);
    expect(manager.getBacklog('pty-exited')).toBe('');
    expect(send).toHaveBeenNthCalledWith(1, 'pty:data', { id: 'pty-exited', data: 'tail output' });
    expect(send).toHaveBeenNthCalledWith(2, 'pty:exit', { id: 'pty-exited', exitCode: undefined });
  });

  it('resize 遇到非已退出异常时只记录失败，不应误删 session', () => {
    const { send, win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const resize = vi.fn(() => {
      throw new Error('native resize failed');
    });

    (manager as any).sessions.set('pty-active', { resize });

    expect(() => manager.resize('pty-active', 100, 24)).not.toThrow();
    expect(manager.hasSession('pty-active')).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});
