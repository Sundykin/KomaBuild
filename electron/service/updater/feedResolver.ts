/**
 * Updater feed URL 解析。
 *
 * 本期单源：GitHub Releases（M-JYuan/Koma）。
 * 留出 `resolveFeedURL()` 接口，未来加国内镜像时只改此函数（双源探测、HEAD 比较、failover）。
 *
 * manifest / 安装包 / blockmap 的最终下载 URL 均由 electron-updater 自己根据
 * `publish` provider 拼装，本模块只负责一件事：返回当前应该使用的 base URL（或 provider 配置）。
 */

export interface ResolvedFeed {
  provider: 'github';
  owner: string;
  repo: string;
  /** manifest.json + .sig 的完整 raw URL（latest tag 下） */
  manifestUrl: string;
  manifestSigUrl: string;
}

const OWNER = 'M-JYuan';
const REPO = 'Koma';

export async function resolveFeed(): Promise<ResolvedFeed> {
  return {
    provider: 'github',
    owner: OWNER,
    repo: REPO,
    manifestUrl: `https://github.com/${OWNER}/${REPO}/releases/latest/download/koma-update-manifest.json`,
    manifestSigUrl: `https://github.com/${OWNER}/${REPO}/releases/latest/download/koma-update-manifest.sig`,
  };
}

/**
 * 主程序下载页面（用户手动下载兜底）。
 */
export function getManualDownloadPageUrl(): string {
  return `https://github.com/${OWNER}/${REPO}/releases/latest`;
}
