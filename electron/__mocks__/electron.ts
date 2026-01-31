/**
 * Vitest 环境下的 Electron 运行时桩（Stub）。
 *
 * 目的：
 * - 单元测试运行在 Node.js 环境，不应依赖 Electron 二进制是否已下载/安装；
 * - 但部分主进程模块会 `import { app } from "electron"` 等，为避免在测试阶段直接抛错，这里提供最小实现。
 *
 * 注意：该文件仅用于测试（通过 vitest alias 注入），不参与生产构建。
 */

/**
 * 空操作（用于替代 Electron API 的副作用方法）。
 *
 * @returns void
 */
function noop(): void {}

/**
 * 返回当前工作目录（用于替代 app.getPath 等路径查询）。
 *
 * @returns 进程工作目录
 */
function cwdPath(): string {
  return process.cwd();
}

/**
 * 模拟 Electron 的 app 对象（仅提供测试所需的最小字段/方法）。
 */
export const app = {
  /** 是否为打包环境（测试环境恒为 false）。 */
  isPackaged: false,
  /**
   * 获取路径（测试环境统一返回 process.cwd()）。
   *
   * @returns 路径字符串
   */
  getPath: (_name: string): string => cwdPath(),
  /**
   * 获取应用目录（测试环境统一返回 process.cwd()）。
   *
   * @returns 路径字符串
   */
  getAppPath: (): string => cwdPath(),
  /** Electron 生命周期相关（测试环境下为空实现）。 */
  on: (_event: string, _cb: (...args: any[]) => void): void => noop(),
};

/**
 * 模拟 BrowserWindow 类型（仅用于被 import 时不报错）。
 */
export class BrowserWindow {}

/**
 * 模拟 ipcMain（用于注册 handler/listener 时不报错）。
 */
export const ipcMain = {
  /**
   * 绑定 handle（空实现）。
   *
   * @returns void
   */
  handle: (_channel: string, _handler: (...args: any[]) => any): void => noop(),
  /**
   * 绑定 listener（空实现）。
   *
   * @returns void
   */
  on: (_channel: string, _listener: (...args: any[]) => any): void => noop(),
  /**
   * 移除 handler（空实现）。
   *
   * @returns void
   */
  removeHandler: (_channel: string): void => noop(),
};

/**
 * 模拟 dialog（避免 import 报错）。
 */
export const dialog: any = {};

/**
 * 模拟 clipboard（避免 import 报错）。
 */
export const clipboard: any = {
  /**
   * 写入文本（空实现）。
   *
   * @returns void
   */
  writeText: (_text: string): void => noop(),
  /**
   * 读取文本（测试环境返回空串）。
   *
   * @returns 文本
   */
  readText: (): string => "",
};

/**
 * 模拟 shell（避免 import 报错）。
 */
export const shell: any = {
  /**
   * 打开外部链接（空实现）。
   *
   * @returns void
   */
  openExternal: async (_url: string): Promise<void> => {},
  /**
   * 打开路径（测试环境返回空串表示无错误）。
   *
   * @returns 错误信息（空串表示成功）
   */
  openPath: async (_path: string): Promise<string> => "",
};

/**
 * 模拟 Menu（避免 import 报错）。
 */
export const Menu: any = {
  /**
   * 设置应用菜单（空实现）。
   *
   * @returns void
   */
  setApplicationMenu: (_menu: any): void => noop(),
  /**
   * 构建菜单（返回空对象）。
   *
   * @returns 菜单对象
   */
  buildFromTemplate: (_template: any[]): any => ({}),
};

/**
 * 模拟 screen（避免 import 报错）。
 */
export const screen: any = {
  /**
   * 获取主显示器（返回最小结构）。
   *
   * @returns 显示器信息
   */
  getPrimaryDisplay: (): any => ({ workAreaSize: { width: 0, height: 0 } }),
};

/**
 * 模拟 session/webContents/nativeTheme（避免 import 报错）。
 */
export const session: any = {};
export const webContents: any = {};
export const nativeTheme: any = {};

/**
 * 模拟 Notification/nativeImage/Event（避免 import 报错）。
 */
export class Notification {
  /**
   * 构造通知（空实现）。
   */
  constructor(_opts?: any) {}

  /**
   * 显示通知（空实现）。
   *
   * @returns void
   */
  show(): void {
    noop();
  }
}

export const nativeImage: any = {
  /**
   * 从路径创建图片（返回空对象）。
   *
   * @returns 图片对象
   */
  createFromPath: (_p: string): any => ({}),
};

export class Event {}

