import { afterEach, describe, expect, it, vi } from 'vitest';

const settingsMock = vi.hoisted(() => ({
  terminalCapabilities: {
    normalizeTerm: true,
    trueColor: false,
  },
  getSettings: vi.fn(),
  getTerminalCapabilitySettings: vi.fn(),
  getTerminalProxyEnabled: vi.fn(() => true),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('./wslConptyProxy.js', async () => {
  const actual = await vi.importActual<typeof import('./wslConpty')>('./wslConpty');
  return {
    spawnIsolatedWslConpty: vi.fn(async (options) => new actual.WslConptyPty(options as any)),
  };
});

vi.mock('./settings.js', () => ({
  default: {
    getSettings: () => {
      settingsMock.getSettings();
      return { terminal: 'pwsh', terminalCapabilities: settingsMock.terminalCapabilities };
    },
    getTerminalCapabilitySettings: () => {
      settingsMock.getTerminalCapabilitySettings();
      return settingsMock.terminalCapabilities;
    },
    getTerminalProxyEnabled: () => settingsMock.getTerminalProxyEnabled(),
  },
}));

vi.mock('./debugConfig.js', () => ({
  getDebugConfig: () => ({ terminal: { pty: { debug: false } } }),
}));

vi.mock('./log.js', () => ({
  perfLogger: { log: vi.fn() },
}));

import { PTYManager } from './pty';
import * as pty from 'node-pty';

describe('PTYManager', () => {
  afterEach(() => {
    settingsMock.terminalCapabilities.normalizeTerm = true;
    settingsMock.terminalCapabilities.trueColor = false;
    settingsMock.getSettings.mockClear();
    settingsMock.getTerminalCapabilitySettings.mockClear();
    settingsMock.getTerminalProxyEnabled.mockReset();
    settingsMock.getTerminalProxyEnabled.mockReturnValue(true);
  });

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

  /**
   * 创建满足 PTYManager 注册监听所需的最小 PTY 桩。
   */
  function createPtyStub() {
    return {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
  }

  it('显式指定终端时应从内存读取能力设置，不加载完整设置与 WSL 列表', async () => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    spawn.mockReset();
    spawn.mockReturnValue(createPtyStub() as any);

    await manager.openWSLConsole({ terminal: 'pwsh' });

    expect(settingsMock.getTerminalCapabilitySettings).toHaveBeenCalledTimes(1);
    expect(settingsMock.getSettings).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'xterm-256color'],
    ['', 'xterm-256color'],
    ['dumb', 'xterm-256color'],
    ['DUMB', 'xterm-256color'],
    ['screen-256color', 'screen-256color'],
  ])('打开 PTY 时应安全归一化 TERM：%s -> %s', async (term, expected) => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    spawn.mockReset();
    spawn.mockReturnValue(createPtyStub() as any);

    await manager.openWSLConsole({
      terminal: 'pwsh',
      env: term === undefined ? {} : { TERM: term },
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[2]?.env?.TERM).toBe(expected);
  });

  it.each(['windows', 'pwsh', 'cmd'] as const)('%s 自动启动命令应等待前端双向绑定', async (terminal) => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    const proc = createPtyStub();
    spawn.mockReset();
    spawn.mockReturnValue(proc as any);

    const opened = await manager.openWSLConsole({ terminal, startupCmd: 'codex --yolo' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(proc.write).not.toHaveBeenCalled();
    expect((spawn.mock.calls[0]?.[2] as { useConptyDll?: boolean } | undefined)?.useConptyDll).toBeUndefined();
    manager.ready(opened.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proc.write).toHaveBeenCalledWith('codex --yolo\r');
    manager.ready(opened.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proc.write).toHaveBeenCalledTimes(1);
  });

  it('Windows 原生终端在首次 resize 暂停结束前不应启动 Codex', async () => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    const proc = createPtyStub();
    spawn.mockReset();
    spawn.mockReturnValue(proc as any);

    const opened = await manager.openWSLConsole({ terminal: 'pwsh', startupCmd: 'codex --yolo' });
    manager.pause(opened.id);
    manager.ready(opened.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(proc.write).not.toHaveBeenCalled();
    manager.resume(opened.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith('codex --yolo\r');
  });

  it('旧渲染层未发送 ready 时应在 2 秒后兜底启动原生终端命令', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { win } = createWindowStub();
      const manager = new PTYManager(() => [win as any]);
      const spawn = vi.mocked(pty.spawn);
      const proc = createPtyStub();
      spawn.mockReset();
      spawn.mockReturnValue(proc as any);

      await manager.openWSLConsole({ terminal: 'cmd', startupCmd: 'codex --yolo' });
      expect(proc.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(proc.write).toHaveBeenCalledWith('codex --yolo\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('原生终端关闭后应取消尚未释放的启动命令', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { win } = createWindowStub();
      const manager = new PTYManager(() => [win as any]);
      const spawn = vi.mocked(pty.spawn);
      const proc = createPtyStub();
      spawn.mockReset();
      spawn.mockReturnValue(proc as any);

      const opened = await manager.openWSLConsole({ terminal: 'pwsh', startupCmd: 'codex --yolo' });
      manager.close(opened.id);
      manager.ready(opened.id);
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(proc.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('应过滤 dumb 父进程注入的 NO_COLOR，但保留终端显式设置', async () => {
    const previousTerm = process.env.TERM;
    const previousNoColor = process.env.NO_COLOR;
    process.env.TERM = 'dumb';
    process.env.NO_COLOR = '1';
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    spawn.mockReset();
    spawn.mockReturnValue(createPtyStub() as any);

    try {
      await manager.openWSLConsole({ terminal: 'pwsh' });
      expect(spawn.mock.calls[0]?.[2]?.env?.TERM).toBe('xterm-256color');
      expect(spawn.mock.calls[0]?.[2]?.env).not.toHaveProperty('NO_COLOR');

      await manager.openWSLConsole({ terminal: 'cmd', env: { NO_COLOR: '1' } });
      expect(spawn.mock.calls[1]?.[2]?.env).toHaveProperty('NO_COLOR', '1');

      process.env.TERM = 'screen-256color';
      await manager.openWSLConsole({ terminal: 'windows' });
      expect(spawn.mock.calls[2]?.[2]?.env).toHaveProperty('NO_COLOR', '1');
    } finally {
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it('关闭终端代理时应清理代理变量并保留显式绕过策略', async () => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    spawn.mockReset();
    spawn.mockReturnValue(createPtyStub() as any);
    settingsMock.getTerminalProxyEnabled.mockReturnValue(false);

    await manager.openWSLConsole({
      terminal: 'pwsh',
      env: {
        HTTP_PROXY: 'http://127.0.0.1:7890',
        https_proxy: 'http://127.0.0.1:7890',
        WSLENV: 'HTTP_PROXY/u:CODEXFLOW_PROXY/u:TERM/u',
      },
    });

    const env = spawn.mock.calls[0]?.[2]?.env as Record<string, string>;
    expect(env).not.toHaveProperty('HTTP_PROXY');
    expect(env).not.toHaveProperty('https_proxy');
    expect(env).toHaveProperty('NO_PROXY', '*');
    expect(env.WSLENV).toBe('TERM/u');
  });

  it('内置和系统 ConPTY 都失败时才应把 WSL 切换为 PowerShell', async () => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    const powershell = createPtyStub();
    spawn.mockReset();
    spawn
      .mockImplementationOnce(() => { throw new Error('bundled conpty failed'); })
      .mockImplementationOnce(() => { throw new Error('system conpty failed'); })
      .mockReturnValueOnce(powershell as any);

    const opened = await manager.openWSLConsole({ terminal: 'wsl' });

    expect(opened.terminal).toBe('windows');
    expect(opened.fallbackReason).toBe('wsl_spawn_failed');
    expect(spawn).toHaveBeenCalledTimes(3);
    expect((spawn.mock.calls[0]?.[2] as { useConptyDll?: boolean }).useConptyDll).toBe(true);
    expect((spawn.mock.calls[1]?.[2] as { useConptyDll?: boolean }).useConptyDll).toBe(false);
  });

  it('WSL 回退到 PowerShell 后也应等待前端绑定再执行启动命令', async () => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    const powershell = createPtyStub();
    spawn.mockReset();
    spawn
      .mockImplementationOnce(() => { throw new Error('bundled conpty failed'); })
      .mockImplementationOnce(() => { throw new Error('system conpty failed'); })
      .mockReturnValueOnce(powershell as any);

    const opened = await manager.openWSLConsole({ terminal: 'wsl', startupCmd: 'codex --yolo' });
    expect(opened.terminal).toBe('windows');
    expect(powershell.write).not.toHaveBeenCalled();

    manager.ready(opened.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(powershell.write).toHaveBeenLastCalledWith('codex --yolo\r');
  });

  it('WSL 自动启动命令应等待前端完成绑定', async () => {
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    const proc = createPtyStub();
    spawn.mockReset();
    spawn.mockReturnValue(proc as any);

    const opened = await manager.openWSLConsole({ terminal: 'wsl', startupCmd: 'codex --yolo' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(proc.write).not.toHaveBeenCalled();
    manager.ready(opened.id);
    expect(proc.write).toHaveBeenCalledWith("bash -lc 'codex --yolo'\r");
  });

  it('ready 应安全忽略无待启动命令的原生 PTY，并向 WSL 同步主题色', () => {
    const manager = new PTYManager(() => []);
    const markFrontendReady = vi.fn();
    (manager as any).sessions.set('wsl-conpty', { markFrontendReady });
    (manager as any).sessions.set('windows-pty', {});
    const colors = { foreground: '#F8F8F2', background: '#282A36' };

    expect(() => manager.ready('windows-pty', colors)).not.toThrow();
    manager.ready('wsl-conpty', colors);

    expect(markFrontendReady).toHaveBeenCalledTimes(1);
    expect(markFrontendReady).toHaveBeenCalledWith(colors);
  });

  it('WSL 应传递能力设置实际补齐的 TERM 与 COLORTERM', async () => {
    settingsMock.terminalCapabilities.trueColor = true;
    const previousNoColor = process.env.NO_COLOR;
    const previousColorTerm = process.env.COLORTERM;
    delete process.env.NO_COLOR;
    delete process.env.COLORTERM;
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    spawn.mockReset();
    spawn.mockReturnValue(createPtyStub() as any);

    try {
      await manager.openWSLConsole({
        terminal: 'wsl',
        env: { TERM: 'dumb' },
      });

      const spawnedEnv = spawn.mock.calls[0]?.[2]?.env;
      const spawnedOptions = spawn.mock.calls[0]?.[2] as { useConptyDll?: boolean } | undefined;
      expect(spawnedEnv?.TERM).toBe('xterm-256color');
      expect(spawnedEnv?.COLORTERM).toBe('truecolor');
      expect(spawnedOptions?.useConptyDll).toBe(true);
      expect(String(spawnedEnv?.WSLENV || '').split(':')).toEqual(expect.arrayContaining(['TERM', 'COLORTERM']));
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousColorTerm === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = previousColorTerm;
    }
  });

  it('WSL 存在 NO_COLOR 时不应传递 COLORTERM', async () => {
    settingsMock.terminalCapabilities.trueColor = true;
    const { win } = createWindowStub();
    const manager = new PTYManager(() => [win as any]);
    const spawn = vi.mocked(pty.spawn);
    spawn.mockReset();
    spawn.mockReturnValue(createPtyStub() as any);

    await manager.openWSLConsole({
      terminal: 'wsl',
      env: { TERM: 'dumb', NO_COLOR: '' },
    });

    const spawnedEnv = spawn.mock.calls[0]?.[2]?.env;
    expect(spawnedEnv?.COLORTERM).not.toBe('truecolor');
    expect(String(spawnedEnv?.WSLENV || '').split(':')).not.toContain('COLORTERM');
  });

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
