/**
 * ShotReferenceBundle 构造器
 *
 * 收集分镜的所有视觉锚点（grid-anchor / shot-anchor / 资产图 / 用户上传）按
 * 优先级排序、按模型上限裁剪，输出统一的引用集合给下游：
 *  - ShotPromptService 用它构造 {{referenceTable}} 模板变量
 *  - shotVideoPlan / videoGenerationRequests 用它构造 ITV provider 请求的
 *    primaryImage / additionalReferences / referenceImages
 *  - shotImageWorkflow 用它构造 TTI provider 请求的 references
 *
 * 不读取 shot.media.images 中带 metadata.gridCell 的拆分子图（历史路径）。
 */
import type { Character, Prop, Scene, Shot, StoredMediaAsset } from '../../types';
import { createMentionString } from '../../editor/mentionTypes';
import { normalizeShotMediaState } from '../../store/project/mediaState';
import type {
  ShotReferenceBundle,
  ShotReferenceBundleOptions,
  ShotReferenceItem,
} from './types';
import { DEFAULT_MAX_REFS } from './types';

/**
 * 优先级常量——配额裁剪时数值越大越优先保留。
 * shot-anchor / grid-anchor 永远必保（priority=100）；其它按重要程度递减。
 */
const PRIORITY = {
  ANCHOR: 100,
  SCENE: 80,
  CHARACTER_LEAD: 70,
  CHARACTER_SUPPORT: 60,
  PROP_PRIMARY: 50,
  PROP_SECONDARY: 40,
  PREVIOUS_STORYBOARD: 90,
  USER_UPLOAD: 30,
} as const;

interface BuildParams {
  shot: Shot;
  characters: Character[];
  scenes: Scene[];
  props: Prop[];
  allShots?: Shot[];
  options?: ShotReferenceBundleOptions;
}

export function buildShotReferenceBundle(params: BuildParams): ShotReferenceBundle {
  const normalized = normalizeShotMediaState(params.shot);
  const maxRefs = Math.max(1, params.options?.maxRefs ?? DEFAULT_MAX_REFS);

  const items: ShotReferenceItem[] = [];
  const mentionFallbacks: Array<{ mentionToken: string; label: string }> = [];
  const seen = new Set<string>();

  // 1. 锚点：grid-anchor 或 shot-anchor，单选
  pushAnchor(normalized, items, seen);

  // 1.5 故事板模式可选继承上一张可用分镜图。它不是当前镜头 primary anchor，
  // 但要进同一 references 索引空间，供后续故事板保持人物/场景/光影连续。
  pushPreviousStoryboardAnchor(params, items, seen);

  // 2. 场景（按 shot.scenes 顺序，单一场景为常见情况）
  for (const sceneId of normalized.scenes || []) {
    const scene = params.scenes.find(s => s.id === sceneId);
    if (!scene) continue;
    const mentionToken = createMentionString('scene', scene.id);
    pushFallback(mentionFallbacks, mentionToken, scene.name);
    const source = scene.media?.previewImage;
    if (!source) continue;
    pushItem(items, seen, {
      kind: 'scene',
      id: scene.id,
      label: `场景：${scene.name}`,
      source,
      mentionToken,
      priority: PRIORITY.SCENE,
      assetId: scene.id,
    });
  }

  // 3. 角色（首个角色按"主角"待遇，后续配角次之）
  (normalized.characters || []).forEach((charId, idx) => {
    const char = params.characters.find(c => c.id === charId);
    if (!char) return;
    const mentionToken = createMentionString('char', char.id);
    pushFallback(mentionFallbacks, mentionToken, char.name);
    const source = pickCharacterVisual(char);
    if (!source) return;
    pushItem(items, seen, {
      kind: 'character',
      id: char.id,
      label: `角色：${char.name}`,
      source,
      mentionToken,
      priority: idx === 0 ? PRIORITY.CHARACTER_LEAD : PRIORITY.CHARACTER_SUPPORT,
      assetId: char.id,
    });
  });

  // 4. 道具
  (normalized.props || []).forEach((propId, idx) => {
    const prop = params.props.find(p => p.id === propId);
    if (!prop) return;
    const mentionToken = createMentionString('prop', prop.id);
    pushFallback(mentionFallbacks, mentionToken, prop.name);
    const source = pickPropVisual(prop);
    if (!source) return;
    pushItem(items, seen, {
      kind: 'prop',
      id: prop.id,
      label: `道具：${prop.name}`,
      source,
      mentionToken,
      priority: idx === 0 ? PRIORITY.PROP_PRIMARY : PRIORITY.PROP_SECONDARY,
      assetId: prop.id,
    });
  });

  // 5. 用户上传（shot.media.references[]）
  (normalized.media?.references || []).forEach((ref, idx) => {
    pushItem(items, seen, {
      kind: 'user-upload',
      id: `${normalized.id}#user-${idx}`,
      label: `用户参考图 ${idx + 1}`,
      source: ref,
      mentionToken: `@user_${idx}`,
      priority: PRIORITY.USER_UPLOAD,
    });
  });

  // 配额裁剪：按 priority 降序保留前 maxRefs 个，截掉的记录到 capacity
  const sorted = [...items].sort((a, b) => b.priority - a.priority);
  const kept = sorted.slice(0, maxRefs);
  const truncated = sorted.slice(maxRefs);
  // 保留时按 priority 排好的顺序作为 references[0..N]——锚点永远在最前
  const orderedItems: ShotReferenceItem[] = kept;

  const hasGridAnchor = orderedItems.some(item => item.kind === 'grid-anchor');
  const hasShotImage = orderedItems.some(item =>
    item.kind === 'grid-anchor'
    || item.kind === 'shot-anchor'
    || item.kind === 'storyboard-anchor'
  );
  // gridCellCount 由 shot.imageMode 派生（builder 是唯一权威源），渲染层不需再读 shot.imageMode。
  let gridCellCount: 4 | 9 | undefined;
  if (hasGridAnchor) {
    if (params.shot.imageMode === 'grid-4') gridCellCount = 4;
    else gridCellCount = 9; // 'grid' 兼容值 + 'grid-9' 都走 9 cell
  }

  return {
    items: orderedItems,
    mentionFallbacks,
    hasGridAnchor,
    gridCellCount,
    hasShotImage,
    capacity: {
      maxRefs,
      truncatedCount: truncated.length,
      truncatedKinds: truncated.map(item => item.kind),
    },
  };
}

function pushFallback(
  fallbacks: Array<{ mentionToken: string; label: string }>,
  mentionToken: string,
  label: string,
): void {
  const cleanLabel = label.trim();
  if (!cleanLabel) return;
  if (fallbacks.some(item => item.mentionToken === mentionToken)) return;
  fallbacks.push({ mentionToken, label: cleanLabel });
}

function pushAnchor(shot: Shot, items: ShotReferenceItem[], seen: Set<string>): void {
  // 锚点图统一来自 shot.media.images[currentImageIndex]。
  // - normalizeShotMediaState 已把老 shot.media.gridImage 合并进 images[0]，
  //   字段本身被剥离，所以 grid-anchor 和 shot-anchor 的数据源是同一处。
  // - kind 区别完全由 shot.imageMode 决定。
  // - 历史拆分子图（带 metadata.gridCell）被显式过滤，避免混入。
  const idx = shot.media?.currentImageIndex ?? 0;
  const candidate = shot.media?.images?.[idx];
  if (!candidate || isGridSplitChild(candidate)) {
    return;
  }

  // 'grid' 旧值兼容为 'grid-9'；'grid-4' 走 2×2，'grid-9' 走 3×3。
  if (shot.imageMode === 'grid' || shot.imageMode === 'grid-9') {
    pushItem(items, seen, {
      kind: 'grid-anchor',
      id: `${shot.id}#grid-9`,
      label: '分镜九宫格锚点（3×3 网格，9 帧时序）',
      source: candidate,
      mentionToken: '@grid_anchor',
      priority: PRIORITY.ANCHOR,
    });
    return;
  }
  if (shot.imageMode === 'grid-4') {
    pushItem(items, seen, {
      kind: 'grid-anchor',
      id: `${shot.id}#grid-4`,
      label: '分镜四宫格锚点（2×2 网格，4 帧时序）',
      source: candidate,
      mentionToken: '@grid_anchor',
      priority: PRIORITY.ANCHOR,
    });
    return;
  }

  if (shot.imageMode === 'storyboard') {
    pushItem(items, seen, {
      kind: 'storyboard-anchor',
      id: `${shot.id}#storyboard`,
      label: '当前故事板锚点（电影故事板 / 制作方案板整图）',
      source: candidate,
      mentionToken: '@storyboard_anchor',
      priority: PRIORITY.ANCHOR,
    });
    return;
  }

  pushItem(items, seen, {
    kind: 'shot-anchor',
    id: shot.id,
    label: '分镜锚点首帧',
    source: candidate,
    mentionToken: '@shot_anchor',
    priority: PRIORITY.ANCHOR,
  });
}

function pushPreviousStoryboardAnchor(params: BuildParams, items: ShotReferenceItem[], seen: Set<string>): void {
  const shot = params.shot;
  if (shot.imageMode !== 'storyboard') return;
  if (shot.inheritPreviousStoryboard === false) return;
  const allShots = params.allShots;
  if (!allShots?.length) return;
  const index = allShots.findIndex(candidate => candidate.id === shot.id);
  if (index <= 0) return;

  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = normalizeShotMediaState(allShots[i]);
    const candidate = pickSelectedShotImage(previous);
    if (!candidate || isGridSplitChild(candidate)) continue;
    pushItem(items, seen, {
      kind: 'previous-storyboard-anchor',
      id: `${previous.id}#selected-image`,
      label: '上一故事板锚点（上一分镜选中图片，用于剧情、场景、人物、光影连续性）',
      source: candidate,
      mentionToken: '@previous_storyboard_anchor',
      priority: PRIORITY.PREVIOUS_STORYBOARD,
    });
    return;
  }
}

function pickSelectedShotImage(shot: Shot): StoredMediaAsset | undefined {
  const images = shot.media?.images || [];
  if (!images.length) return undefined;
  const currentIndex = shot.media?.currentImageIndex ?? 0;
  const selected = images[currentIndex];
  if (selected && !isGridSplitChild(selected)) return selected;
  return images.find(image => !isGridSplitChild(image));
}

/** 判断是否是九宫格拆分留下的子图（历史路径，新架构不参与）。 */
function isGridSplitChild(asset: StoredMediaAsset): boolean {
  return typeof asset?.metadata?.gridCell === 'number';
}

function pickCharacterVisual(character: Character): StoredMediaAsset | undefined {
  return character.media?.costumePhoto;
}

function pickPropVisual(prop: Prop): StoredMediaAsset | undefined {
  return prop.media?.previewImage;
}

/**
 * 推入并去重。同一 source 在 bundle 中只占一个槽位，避免角色/道具图重复贡献。
 */
function pushItem(
  items: ShotReferenceItem[],
  seen: Set<string>,
  item: ShotReferenceItem,
): void {
  const dedupeKey = sourceDedupeKey(item.source);
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  items.push(item);
}

function sourceDedupeKey(source: ShotReferenceItem['source']): string {
  if (typeof source === 'string') return `str:${source}`;
  return `asset:${source.localPath ?? source.remoteUrl ?? source.providerTaskId ?? JSON.stringify(source)}`;
}
