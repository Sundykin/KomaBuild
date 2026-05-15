#!/usr/bin/env node
/**
 * update-plugin-registry.cjs
 *
 * 在插件发布流水线里运行：
 *   1. 拉 M-JYuan/Koma main 上的 plugin-registry.json
 *   2. 加/更新 当前插件条目（id, name, latestVersion, sha512, downloadUrl, engine 等）
 *   3. ed25519 重签整个注册表（用规范化 JSON）
 *   4. 把新 registry 写回 Koma 的 main 分支
 *
 * 调用方式：作为 GitHub Actions job 的最后一步运行。仓库已 actions/checkout 了
 * Koma main 到本地路径 $REGISTRY_REPO_DIR。
 *
 * 入参（环境变量）:
 *   REGISTRY_REPO_DIR     Koma 仓库 checkout 路径（必填）
 *   PLUGIN_ID             插件 id（必填）
 *   PLUGIN_VERSION        插件版本（必填）
 *   PLUGIN_NAME           显示名（必填）
 *   PLUGIN_CATEGORY       provider | global | tool | mcp | agent
 *   PLUGIN_DESCRIPTION    简介（可选）
 *   PLUGIN_ICON_URL       图标 URL（可选）
 *   PLUGIN_DOWNLOAD_URL   插件 zip 的完整下载 URL（必填）
 *   PLUGIN_ZIP_PATH       插件 zip 的本地路径（用于算 SHA512）（必填）
 *   PLUGIN_ENGINE_MIN     engine.minAppVersion（可选）
 *   PLUGIN_ENGINE_MAX     engine.maxAppVersion（可选）
 *   PLUGIN_ENGINE_API     engine.apiVersion（可选；默认 v1）
 *   KOMA_UPDATE_SIGN_KEY  base64 PKCS#8 PEM 私钥
 *
 * 注意：本脚本不做 git commit/push。CI workflow 在脚本执行成功后自行 commit。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function die(msg) {
  console.error(`[update-plugin-registry] ${msg}`);
  process.exit(1);
}

const REPO_DIR = process.env.REGISTRY_REPO_DIR;
const PLUGIN_ID = process.env.PLUGIN_ID;
const PLUGIN_VERSION = process.env.PLUGIN_VERSION;
const PLUGIN_NAME = process.env.PLUGIN_NAME;
const PLUGIN_CATEGORY = process.env.PLUGIN_CATEGORY;
const PLUGIN_DESCRIPTION = process.env.PLUGIN_DESCRIPTION || '';
const PLUGIN_ICON_URL = process.env.PLUGIN_ICON_URL || '';
const PLUGIN_DOWNLOAD_URL = process.env.PLUGIN_DOWNLOAD_URL;
const PLUGIN_ZIP_PATH = process.env.PLUGIN_ZIP_PATH;
const ENGINE_MIN = process.env.PLUGIN_ENGINE_MIN || null;
const ENGINE_MAX = process.env.PLUGIN_ENGINE_MAX || null;
const ENGINE_API = process.env.PLUGIN_ENGINE_API || 'v1';
const SIGN_KEY_B64 = process.env.KOMA_UPDATE_SIGN_KEY;

if (!REPO_DIR) die('REGISTRY_REPO_DIR is required');
if (!PLUGIN_ID) die('PLUGIN_ID is required');
if (!PLUGIN_VERSION) die('PLUGIN_VERSION is required');
if (!PLUGIN_NAME) die('PLUGIN_NAME is required');
if (!PLUGIN_DOWNLOAD_URL) die('PLUGIN_DOWNLOAD_URL is required');
if (!PLUGIN_ZIP_PATH) die('PLUGIN_ZIP_PATH is required');
if (!SIGN_KEY_B64) die('KOMA_UPDATE_SIGN_KEY is required');

const privateKey = crypto.createPrivateKey(Buffer.from(SIGN_KEY_B64, 'base64').toString('utf8'));

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

const zipBuf = fs.readFileSync(PLUGIN_ZIP_PATH);
const sha512 = crypto.createHash('sha512').update(zipBuf).digest('base64');

const registryPath = path.join(REPO_DIR, 'plugin-registry.json');

let registry;
if (fs.existsSync(registryPath)) {
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    die(`existing plugin-registry.json is malformed: ${err.message}`);
  }
} else {
  registry = { registryVersion: 1, updatedAt: new Date().toISOString(), plugins: [] };
}

// 强制 schema 字段存在
if (typeof registry.registryVersion !== 'number') registry.registryVersion = 1;
if (!Array.isArray(registry.plugins)) registry.plugins = [];

const engine = {};
if (ENGINE_MIN) engine.minAppVersion = ENGINE_MIN;
if (ENGINE_MAX) engine.maxAppVersion = ENGINE_MAX;
engine.apiVersion = ENGINE_API;

const newEntry = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  latestVersion: PLUGIN_VERSION,
  category: PLUGIN_CATEGORY || undefined,
  iconUrl: PLUGIN_ICON_URL || undefined,
  description: PLUGIN_DESCRIPTION || undefined,
  downloadUrl: PLUGIN_DOWNLOAD_URL,
  sha512,
  size: zipBuf.length,
  engine,
};

const idx = registry.plugins.findIndex((p) => p.id === PLUGIN_ID);
if (idx >= 0) registry.plugins[idx] = newEntry;
else registry.plugins.push(newEntry);

registry.updatedAt = new Date().toISOString();
delete registry.signature;

const canonical = JSON.stringify(sortKeysDeep(registry));
const sig = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');
registry.signature = sig;

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
console.log(`[update-plugin-registry] wrote ${registryPath}`);
console.log(`[update-plugin-registry] plugin ${PLUGIN_ID}@${PLUGIN_VERSION} sha512=${sha512.slice(0, 16)}...`);
console.log(`[update-plugin-registry] registry signature: ${sig.slice(0, 16)}...`);
