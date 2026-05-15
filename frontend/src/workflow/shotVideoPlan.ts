import type {
  AppSettings,
  Character,
  ITVRequest,
  MediaAssetSource,
  Prop,
  Scene,
  Shot,
  ShotVideoMode,
  StoredMediaAsset,
  VideoGenerationCapability,
} from '../types';
import { getMediaAssetDisplaySource } from '../types';
import { DEFAULT_VIDEO_DURATION_SECONDS } from '../utils/videoDuration';
import type { ModelCapability } from '../providers/channel/types';
import { buildVideoCapabilityRequest } from '../services/promptCompilation/videoRequestCompiler';
import { normalizeShotMediaState } from '../store/project/mediaState';
import {
  listConfiguredModelSelectOptions,
  resolveConfiguredChannelModel,
  type ResolvedChannelModelContext,
} from '../providers/channel/resolver';
import { buildShotReferenceBundle } from '../services/shotReference/builder';
import type { ShotReferenceBundle, ShotReferenceItem } from '../services/shotReference/types';

export const SHOT_VIDEO_CAPABILITY_LABELS: Record<VideoGenerationCapability, string> = {
  'video.text-to-video': '文生视频',
  'video.image-to-video': '图生视频',
  'video.reference-to-video': '参考生视频',
  'video.start-end-to-video': '首尾帧视频',
};

export interface ShotVideoPlan {
  shot: Shot;
  /**
   * 阶段 2 引入的统一引用集合。生图和生视频共用同一份 bundle.items，下游严格
   * 按 items 的位置顺序分配 references[0..N]。primaryImageInput / additional /
   * visualReferenceInputs 是从 bundle 派生出来的视图——保留给老消费者使用，新
   * 代码应优先消费 bundle。
   */
  bundle: ShotReferenceBundle;
  selectedImageAsset?: StoredMediaAsset;
  selectedImageSource?: string;
  primaryImageInput?: MediaAssetSource;
  primaryImageSource?: string;
  visualReferenceInputs: MediaAssetSource[];
  additionalReferenceImages: MediaAssetSource[];
  capability: VideoGenerationCapability;
  capabilityLabel: string;
}

export interface ShotVideoCapabilitySupport {
  requestedCapability: VideoGenerationCapability;
  capability: VideoGenerationCapability;
  capabilityLabel: string;
  resolvedContext?: ResolvedChannelModelContext;
  effectiveSelectionKey?: string;
  disabledReason?: string;
}

function getVideoThumbnailSource(asset?: StoredMediaAsset): string | undefined {
  if (!asset || asset.kind !== 'video') return undefined;
  const thumbnailPath = typeof asset.metadata?.thumbnailPath === 'string'
    ? asset.metadata.thumbnailPath.trim()
    : '';
  return thumbnailPath || undefined;
}

function getVisualReferenceSource(source?: MediaAssetSource): string | undefined {
  if (!source) return undefined;
  if (typeof source === 'string') {
    return source.trim() || undefined;
  }
  if (source.kind === 'video') {
    return getVideoThumbnailSource(source);
  }
  return getMediaAssetDisplaySource(source)?.trim() || undefined;
}

export function collectShotVideoPlan(params: {
  shot: Shot;
  characters: Character[];
  scenes: Scene[];
  props: Prop[];
  allShots?: Shot[];
  /**
   * 当前选中 ITV 模型的能力矩阵。传入后：
   *  - 模型支持 video.reference-to-video 且分镜处于 multi-ref 模式：把分镜锚点
   *    图（grid-anchor / shot-anchor）和资产图全部作 references；
   *  - 模型不支持时按 image-to-video 退化（锚点作 primary，资产/上传作 additional）。
   *
   * 未传入时按保守策略：仅当 shot 有锚点或用户上传时走 image-to-video，资产
   * 视觉默认不进 additional——保持老调用路径在测试场景下的语义。
   */
  modelCapabilities?: ModelCapability[];
  /** 模型可接受的最大引用图数量。不传时由 bundle builder 走 DEFAULT_MAX_REFS。 */
  modelMaxRefs?: number;
}): ShotVideoPlan {
  const normalizedShot = normalizeShotMediaState(params.shot);
  const selectedImageIndex = normalizedShot.media?.currentImageIndex ?? 0;
  const selectedImageAsset = normalizedShot.media?.images?.[selectedImageIndex];
  const selectedImageSource = getVisualReferenceSource(selectedImageAsset);

  // 一份 bundle 既给生图也给生视频；下游路由按 capability 分发到 primaryImage /
  // additionalReferences / referenceImages。
  const bundle = buildShotReferenceBundle({
    shot: normalizedShot,
    characters: params.characters,
    scenes: params.scenes,
    props: params.props,
    allShots: params.allShots,
    options: { maxRefs: params.modelMaxRefs },
  });

  const knowsModelCaps = !!params.modelCapabilities;
  const supportsRefToVideo = params.modelCapabilities?.includes('video.reference-to-video') ?? false;
  const videoMode: ShotVideoMode = normalizedShot.videoMode ?? 'multi-ref';

  const routed = routeBundleToCapability({
    bundle,
    supportsRefToVideo,
    knowsModelCaps,
    videoMode,
  });

  return {
    shot: normalizedShot,
    bundle,
    selectedImageAsset,
    selectedImageSource,
    primaryImageInput: routed.primaryImageInput,
    primaryImageSource: getVisualReferenceSource(routed.primaryImageInput),
    visualReferenceInputs: routed.visualReferenceInputs,
    additionalReferenceImages: routed.additionalReferenceImages,
    capability: routed.capability,
    capabilityLabel: SHOT_VIDEO_CAPABILITY_LABELS[routed.capability],
  };
}

interface RoutedBundle {
  capability: VideoGenerationCapability;
  primaryImageInput?: MediaAssetSource;
  additionalReferenceImages: MediaAssetSource[];
  visualReferenceInputs: MediaAssetSource[];
}

/**
 * 把 bundle 派生成 ITVRequest 各字段值。决策依据：
 *  - bundle 是否含当前分镜锚点（grid-anchor / shot-anchor / storyboard-anchor）
 *  - 当前模型是否支持 video.reference-to-video
 *  - 是否知道模型能力（modelCapabilities 是否传入）
 *  - 分镜的 videoMode（multi-ref / first-frame）
 *
 * 输出始终同步填三个字段（primaryImageInput / additionalReferenceImages /
 * visualReferenceInputs），即使 capability 是 reference-to-video 也保留
 * primaryImageInput——这样上层 capability 被 capabilitySupport 降级（例如
 * 模型实际只支持 image-to-video）时，request 仍然能正确构造。
 */
function routeBundleToCapability(params: {
  bundle: ShotReferenceBundle;
  supportsRefToVideo: boolean;
  knowsModelCaps: boolean;
  videoMode: ShotVideoMode;
}): RoutedBundle {
  const { bundle, supportsRefToVideo, knowsModelCaps, videoMode } = params;
  const items = bundle.items;
  const allSources = items.map(item => item.source);

  // 1) 有当前分镜锚点（shot-anchor / grid-anchor / storyboard-anchor）
  if (bundle.hasShotImage) {
    const anchorItem = items.find(isAnchorItem)!;
    const otherItems = items.filter(item => item !== anchorItem);
    const additional = pickAdditionalSources(otherItems, knowsModelCaps);

    if (supportsRefToVideo && videoMode === 'multi-ref') {
      // 新行为：multi-ref + 模型支持 ref-to-video → 锚点 + 资产 + 用户上传 全作 references
      return {
        capability: 'video.reference-to-video',
        primaryImageInput: anchorItem.source,
        additionalReferenceImages: additional,
        visualReferenceInputs: allSources,
      };
    }

    // 兼容：first-frame 或 模型不支持 ref-to-video → image-to-video
    return {
      capability: 'video.image-to-video',
      primaryImageInput: anchorItem.source,
      additionalReferenceImages: additional,
      visualReferenceInputs: [anchorItem.source, ...additional],
    };
  }

  // 2) 无锚点 + 模型支持 ref-to-video + bundle 非空 → 资产 / 用户上传 都作 references
  if (supportsRefToVideo && items.length > 0) {
    const fallbackPrimary = items[0].source; // 主要给降级分支留底
    return {
      capability: 'video.reference-to-video',
      primaryImageInput: fallbackPrimary,
      additionalReferenceImages: items.slice(1).map(item => item.source),
      visualReferenceInputs: allSources,
    };
  }

  // 3) 无锚点 + 不支持 ref-to-video + 有用户上传 → 用户上传作 primary（兼容老逻辑）
  const userUploadIdx = items.findIndex(item => item.kind === 'user-upload');
  if (userUploadIdx >= 0) {
    const primary = items[userUploadIdx];
    const otherItems = items.filter(item => item !== primary);
    const additional = pickAdditionalSources(otherItems, knowsModelCaps);
    return {
      capability: 'video.image-to-video',
      primaryImageInput: primary.source,
      additionalReferenceImages: additional,
      visualReferenceInputs: [primary.source, ...additional],
    };
  }

  // 4) 无锚点 + 不支持 ref-to-video + 没用户上传 + 仅资产视觉 + modelCaps 已知
  //    → 把首个资产视觉提为 primary
  if (knowsModelCaps && items.length > 0) {
    const primary = items[0];
    const otherItems = items.slice(1);
    return {
      capability: 'video.image-to-video',
      primaryImageInput: primary.source,
      additionalReferenceImages: otherItems.map(item => item.source),
      visualReferenceInputs: allSources,
    };
  }

  // 5) 默认：text-to-video（modelCaps 未知 + 仅资产视觉时维持老语义，资产不进视频）
  return {
    capability: 'video.text-to-video',
    additionalReferenceImages: [],
    visualReferenceInputs: [],
  };
}

function isAnchorItem(item: ShotReferenceItem): boolean {
  return item.kind === 'shot-anchor'
    || item.kind === 'grid-anchor'
    || item.kind === 'storyboard-anchor'
    || item.kind === 'previous-storyboard-anchor';
}

/**
 * 从非锚点 items 里挑出可进 additionalReferences 的视觉源。
 *  - modelCaps 已知：全部进（资产视觉 + 用户上传）—— 修复"角色图被悄悄丢"的暗坑
 *  - modelCaps 未知：仅 user-upload，保留老调用路径的兼容语义
 */
function pickAdditionalSources(items: ShotReferenceItem[], knowsModelCaps: boolean): MediaAssetSource[] {
  const filtered = knowsModelCaps
    ? items
    : items.filter(item => item.kind === 'user-upload');
  return filtered.map(item => item.source);
}

function coerceShotVideoRequestDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.round(value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.round(parsed));
  }
  return DEFAULT_VIDEO_DURATION_SECONDS;
}

export function buildShotVideoRequest(params: {
  plan: ShotVideoPlan;
  prompt: string;
  aspectRatio: string;
  duration: number;
  motionPrompt?: string;
  capability?: VideoGenerationCapability;
}): ITVRequest<MediaAssetSource> {
  const capability = params.capability || params.plan.capability;
  const options = {
    duration: coerceShotVideoRequestDuration(params.duration),
    motionPrompt: params.motionPrompt,
    aspectRatio: params.aspectRatio,
  };

  if (capability === 'video.image-to-video') {
    return buildVideoCapabilityRequest<MediaAssetSource>({
      capability,
      prompt: params.prompt,
      primaryImage: params.plan.primaryImageInput,
      additionalReferences: params.plan.additionalReferenceImages,
      options,
    });
  }

  if (capability === 'video.reference-to-video') {
    return buildVideoCapabilityRequest<MediaAssetSource>({
      capability,
      prompt: params.prompt,
      referenceImages: params.plan.visualReferenceInputs,
      options,
    });
  }

  return buildVideoCapabilityRequest<MediaAssetSource>({
    capability: 'video.text-to-video',
    prompt: params.prompt,
    options,
  });
}

export function resolveShotVideoCapabilitySupport(params: {
  settings: AppSettings;
  selectionKey?: string;
  capability: VideoGenerationCapability;
  visualInputCount?: number;
}): ShotVideoCapabilitySupport {
  const resolvedContext = resolveConfiguredChannelModel(
    params.settings,
    'itv',
    params.selectionKey,
    params.capability,
  );
  if (resolvedContext) {
    return {
      requestedCapability: params.capability,
      capability: params.capability,
      capabilityLabel: SHOT_VIDEO_CAPABILITY_LABELS[params.capability],
      resolvedContext,
      effectiveSelectionKey: params.selectionKey,
    };
  }

  const availableModels = listConfiguredModelSelectOptions(
    params.settings,
    'itv',
    params.capability,
  );
  const targetCapability = params.capability;
  const capabilityLabel = SHOT_VIDEO_CAPABILITY_LABELS[targetCapability];
  const selectedContext = params.selectionKey
    ? resolveConfiguredChannelModel(params.settings, 'itv', params.selectionKey)
    : undefined;

  return {
    requestedCapability: params.capability,
    capability: targetCapability,
    capabilityLabel,
    effectiveSelectionKey: params.selectionKey,
    disabledReason: selectedContext && availableModels.length > 0
      ? `当前选择的模型不支持${capabilityLabel}，请切换模型`
      : `当前没有配置支持${capabilityLabel}的视频模型`,
  };
}
