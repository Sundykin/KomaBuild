/**
 * 拉取插件注册表 plugin-registry.json。
 *
 * 来源：GitHub raw（main 分支）。
 * 验签：用统一 ed25519 公钥校验 registry.signature 字段（manifestVerifier.verifyPluginRegistry）。
 * 缓存：HTTP ETag 条件请求节省流量；304 时直接使用本地缓存（不重新验签 / 不更新 lastCheckedAt 的 etag）。
 *
 * 本期不做镜像；若以后加，把 RAW_URL 抽到 feedResolver 即可。
 */
import { app } from 'electron';
import * as https from 'node:https';

import {
  verifyPluginRegistry,
  type PluginRegistry,
} from '../release-signing/manifestVerifier';
import { marketplaceStore } from './store';

const RAW_URL =
  'https://raw.githubusercontent.com/M-JYuan/Koma/main/plugin-registry.json';

export interface FetchRegistryResult {
  ok: boolean;
  notModified?: boolean;
  registry?: PluginRegistry;
  /** 失败时给前端展示的人话原因 */
  reason?: string;
  etag?: string;
}

export async function fetchRegistry(): Promise<FetchRegistryResult> {
  const ifNoneMatch = marketplaceStore.getRegistryEtag();
  try {
    const res = await httpsGetWithEtag(RAW_URL, ifNoneMatch);
    if (res.statusCode === 304) {
      return { ok: true, notModified: true };
    }
    if (res.statusCode !== 200) {
      return { ok: false, reason: `HTTP ${res.statusCode}` };
    }
    const verifyRes = verifyPluginRegistry(res.body);
    if (!verifyRes.ok) {
      return { ok: false, reason: `signature: ${verifyRes.reason ?? 'invalid'}` };
    }
    if (res.etag) marketplaceStore.setRegistryEtag(res.etag);
    marketplaceStore.setLastCheckedAt(new Date().toISOString());
    return { ok: true, registry: verifyRes.registry, etag: res.etag };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message ?? String(err) };
  }
}

interface RawResponse {
  statusCode: number;
  body: string;
  etag?: string;
}

function httpsGetWithEtag(url: string, ifNoneMatch: string | null, maxRedirects = 5): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'user-agent': `Koma-Updater/${safeVersion()}`,
    };
    if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;

    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        return resolve(httpsGetWithEtag(res.headers.location, ifNoneMatch, maxRedirects - 1));
      }
      const status = res.statusCode ?? 0;
      if (status === 304) {
        res.resume();
        return resolve({ statusCode: 304, body: '' });
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: status,
          body: Buffer.concat(chunks).toString('utf8'),
          etag: typeof res.headers.etag === 'string' ? res.headers.etag : undefined,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Registry request timeout')));
  });
}

function safeVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}
