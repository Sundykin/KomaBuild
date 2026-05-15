/**
 * UpdaterService — 主程序自动更新（极简版）
 *
 * 用户视角只有"一个按钮"，所以本服务只暴露三个动作：
 *   - checkNow():   主动检查（启动时自动调一次；前端的 About 子页不再触发）
 *   - download():   下载更新（用户点"更新到 vX.Y.Z"按钮触发）
 *   - installNow(): 重启并安装（用户点"重启以更新"按钮触发）
 *
 * 状态机：idle → checking → { idle | downloading } → { downloaded | failed }
 *
 * 安全不变量（不可砍）：
 *   1. ed25519 manifest 签名 + 单调递增 + 30 天过期保护（manifestVerifier）
 *   2. electron-updater 二层 SHA512 校验
 *   3. 长任务运行中拒绝 quitAndInstall（user 不感知；下次启动会自动安装）
 *   4. 失败永不删除当前可执行文件
 *
 * 自动重试：失败后 6 小时定时再试，用户无感。
 */

import { app, shell, BrowserWindow } from 'electron';
import { autoUpdater, type AppUpdater, type UpdateInfo } from 'electron-updater';
import { logger } from 'ee-core/log';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';

import { getUpdaterCacheDir } from '../paths';
import {
  verifyAppManifest,
  compareSemver,
  sha512Base64,
  type UpdateManifest,
} from '../release-signing/manifestVerifier';
import { updaterStore } from './store';
import { isLongTaskRunning } from './longTaskGuard';
import {
  detectPlatformInfo,
  isMacGuidedFlow,
  macDmgCacheName,
  manifestKeyForCurrent,
} from './platformStrategy';
import { resolveFeed, getManualDownloadPageUrl } from './feedResolver';
import type { UpdaterState } from './types';

const STARTUP_CHECK_DELAY_MS = 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000; // 失败后 6h 自动再试
const STATE_CHANNEL = 'updater:state-changed';

export class UpdaterService {
  private state: UpdaterState;
  private startupTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private currentManifest: UpdateManifest | null = null;
  private pendingDownloadedFilePath: string | null = null;
  private nativeUpdaterWired = false;
  private consecutiveFailures = 0;

  constructor() {
    this.state = {
      kind: 'idle',
      currentVersion: app.getVersion(),
    };
    // 注意：不在 constructor 里 bumpLastInstalledVersion——版本迁移 (versionMigration.ts)
    // 必须先读到旧版本号才能判断"是否升级"。bump 推迟到 start() 调用。
  }

  start(): void {
    // 把当前版本写入防降级锚点。runVersionMigrationIfNeeded() 已经在本服务启动前
    // 读取过旧值并执行了清理，到这一步可以安全地把锚点向前推进。
    updaterStore.bumpLastInstalledVersion(app.getVersion(), compareSemver);

    this.startupTimer = setTimeout(() => {
      this.checkNow().catch((err) => logger.warn('[updater] startup check failed', err));
    }, STARTUP_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.startupTimer = null;
    this.retryTimer = null;
  }

  getState(): UpdaterState {
    return this.state;
  }

  async checkNow(): Promise<UpdaterState> {
    if (this.state.kind === 'checking' || this.state.kind === 'downloading') {
      return this.state;
    }
    this.setState({ ...this.state, kind: 'checking', error: undefined });
    try {
      const manifest = await this.fetchAndVerifyManifest();
      if (!manifest) {
        this.setState({
          kind: 'idle',
          currentVersion: app.getVersion(),
        });
        this.consecutiveFailures = 0;
        return this.state;
      }
      this.currentManifest = manifest;
      this.setState({
        kind: 'idle',
        currentVersion: app.getVersion(),
        availableVersion: manifest.version,
      });
      this.consecutiveFailures = 0;
      return this.state;
    } catch (err) {
      logger.warn('[updater] check failed', err);
      this.onFailure(err as Error);
      return this.state;
    }
  }

  async download(): Promise<void> {
    if (this.state.kind === 'downloading' || this.state.kind === 'downloaded') return;
    const manifest = this.currentManifest;
    if (!manifest) {
      // 兜底：用户在没有 manifest 的情况下点了按钮（理论上 UI 会不显示）
      await this.checkNow();
      if (!this.currentManifest) return;
    }
    const info = detectPlatformInfo(process.execPath);
    if (!info.canAutoUpdate) {
      // portable / unsupported 直接打开下载页
      await shell.openExternal(getManualDownloadPageUrl());
      return;
    }
    try {
      if (info.useElectronUpdater) {
        await this.downloadViaElectronUpdater();
      } else if (isMacGuidedFlow(info)) {
        await this.downloadMacDmgGuided(this.currentManifest!);
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      logger.warn('[updater] download failed', err);
      this.onFailure(err as Error);
    }
  }

  /**
   * 用户点"重启以更新"——长任务运行中静默忽略（不抛错给前端）。
   * 用户的下次启动会经 update-downloaded 持久化恢复到 ready，自动尝试。
   */
  async installNow(): Promise<void> {
    if (this.state.kind !== 'downloaded') return;
    if (isLongTaskRunning()) {
      logger.info('[updater] installNow blocked: long task running');
      return;
    }
    const info = detectPlatformInfo(process.execPath);
    if (info.useElectronUpdater) {
      // quitAndInstall 关闭所有窗口 → OS installer 接管
      autoUpdater.quitAndInstall(false, true);
      return;
    }
    if (isMacGuidedFlow(info) && this.pendingDownloadedFilePath) {
      // 未签名 mac 过渡：让 Finder 打开 dmg，旧版本继续运行直到用户手动拖
      await shell.openPath(this.pendingDownloadedFilePath);
      return;
    }
  }

  // ---------- 内部 ----------

  private setState(next: UpdaterState): void {
    this.state = next;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(STATE_CHANNEL, next);
      }
    }
  }

  private onFailure(err: Error): void {
    this.consecutiveFailures += 1;
    this.setState({
      kind: 'failed',
      currentVersion: app.getVersion(),
      availableVersion: this.state.availableVersion,
      error: { message: '更新失败，将自动重试', detail: err?.message ?? String(err) },
    });
    // 连续失败 3 次 → 静默打开下载页（用户大概率正在受网络困扰，给个兜底）
    if (this.consecutiveFailures === 3) {
      shell.openExternal(getManualDownloadPageUrl()).catch(() => {});
    }
    // 失败后 6 小时定时再试
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState({ kind: 'idle', currentVersion: app.getVersion() });
      this.checkNow().catch(() => {});
    }, RETRY_AFTER_FAILURE_MS);
  }

  private async fetchAndVerifyManifest(): Promise<UpdateManifest | null> {
    const feed = await resolveFeed();
    const [manifestJson, sigB64] = await Promise.all([
      httpsGetText(feed.manifestUrl),
      httpsGetText(feed.manifestSigUrl).then((s) => s.trim()),
    ]);
    const result = verifyAppManifest(manifestJson, sigB64, updaterStore.getLastInstalledVersion());
    if (!result.ok) {
      logger.warn('[updater] manifest verify rejected', { reason: result.reason });
      return null;
    }
    const manifest = JSON.parse(manifestJson) as UpdateManifest;
    if (compareSemver(manifest.version, app.getVersion()) <= 0) {
      return null;
    }
    return manifest;
  }

  private wireElectronUpdaterOnce(): AppUpdater {
    if (this.nativeUpdaterWired) return autoUpdater;
    this.nativeUpdaterWired = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true; // 用户没点"立即重启"时，下次启动自动安装
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: (m: any) => logger.info('[electron-updater]', m),
      warn: (m: any) => logger.warn('[electron-updater]', m),
      error: (m: any) => logger.error('[electron-updater]', m),
      debug: (m: any) => logger.debug?.('[electron-updater]', m),
    } as any;

    autoUpdater.on('download-progress', (p) => {
      this.setState({
        ...this.state,
        kind: 'downloading',
        downloadProgress: (p?.percent ?? 0) / 100,
      });
    });
    autoUpdater.on('update-downloaded', (_info: UpdateInfo) => {
      this.setState({
        ...this.state,
        kind: 'downloaded',
        downloadProgress: 1,
      });
    });
    autoUpdater.on('error', (err: Error) => {
      this.onFailure(err);
    });
    return autoUpdater;
  }

  private async downloadViaElectronUpdater(): Promise<void> {
    const updater = this.wireElectronUpdaterOnce();
    this.setState({ ...this.state, kind: 'downloading', downloadProgress: 0 });
    const result = await updater.checkForUpdates();
    if (!result?.downloadPromise) {
      await updater.downloadUpdate();
    } else {
      await result.downloadPromise;
    }
  }

  private async downloadMacDmgGuided(manifest: UpdateManifest): Promise<void> {
    const platKey = manifestKeyForCurrent();
    const entry = manifest.platforms[platKey];
    if (!entry) {
      throw new Error(`Manifest does not list current platform: ${platKey}`);
    }
    const downloadUrl = absoluteDownloadUrl(entry.file);
    const cacheDir = getUpdaterCacheDir();
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const localPath = path.join(cacheDir, macDmgCacheName(manifest.version, platKey));

    this.setState({ ...this.state, kind: 'downloading', downloadProgress: 0 });
    await httpsDownload(downloadUrl, localPath, (received, total) => {
      this.setState({
        ...this.state,
        kind: 'downloading',
        downloadProgress: total > 0 ? received / total : 0,
      });
    });
    const buf = await fs.promises.readFile(localPath);
    const actualSha = sha512Base64(buf);
    const expected = entry.sha512;
    const expectedNormalized = expected.length === 88 ? expected : expected.toLowerCase();
    const actualNormalized = expected.length === 88 ? actualSha : sha512Hex(buf);
    if (actualNormalized !== expectedNormalized) {
      await fs.promises.unlink(localPath).catch(() => {});
      throw new Error('SHA512 mismatch — package may be corrupted or tampered with');
    }
    this.pendingDownloadedFilePath = localPath;
    this.setState({ ...this.state, kind: 'downloaded', downloadProgress: 1 });
  }
}

// ----- helpers -----

function sha512Hex(buf: Buffer): string {
  return require('node:crypto').createHash('sha512').update(buf).digest('hex');
}

function absoluteDownloadUrl(fileFieldOrUrl: string): string {
  if (/^https?:\/\//i.test(fileFieldOrUrl)) return fileFieldOrUrl;
  // 注意：manifest 里的 file 字段已是 GitHub 上传后的实际文件名（空格→点），
  // 但仍可能含其他需要编码的字符。统一 encodeURIComponent，保证 URL 合法。
  return `https://github.com/M-JYuan/Koma/releases/latest/download/${encodeURIComponent(fileFieldOrUrl)}`;
}

function httpsGetText(url: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': `Koma-Updater/${app.getVersion()}` } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          return resolve(httpsGetText(res.headers.location, maxRedirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Request timeout')));
  });
}

function httpsDownload(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
  maxRedirects = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': `Koma-Updater/${app.getVersion()}` } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          return resolve(httpsDownload(res.headers.location, destPath, onProgress, maxRedirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          onProgress(received, total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('Download timeout')));
  });
}

let _service: UpdaterService | null = null;
export function initUpdaterService(): UpdaterService {
  if (_service) return _service;
  _service = new UpdaterService();
  _service.start();
  return _service;
}
export function getUpdaterService(): UpdaterService | null {
  return _service;
}
