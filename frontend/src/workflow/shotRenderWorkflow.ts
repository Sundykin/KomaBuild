/**
 * 分镜视频生成工作流
 * 纯 ITV 调用：使用已有参考图片（可选）生成视频
 */
import {
  getMediaAssetDisplaySource,
  isImageToVideoRequest,
  isReferenceToVideoRequest,
  type AppSettings,
  type Character,
  type Prop,
  type Scene,
  type Shot,
  type ShotVersion,
} from '../types';
import { saveShotVersion, loadShotMeta, loadCharacters, loadProps, loadScenes, loadEpisodeShots } from '../store/projectStore';
import { createLogger } from '../store/logger';
import { logITVCall } from '../store/aiCallLogger';
import {
  normalizeCharactersMediaState,
  normalizePropsMediaState,
  normalizeScenesMediaState,
  normalizeShotMediaState,
} from '../store/project/mediaState';
import { mediaGenerationService } from '../services/MediaGenerationService';
import {
  ensureExplicitDialogueInVideoPrompt,
  sanitizeVideoPromptResult,
} from '../services/ShotPromptService';
import { normalizeProjectNarrativeMode } from '../services/narrativeMode';
import {
  collectShotVideoPlan,
  resolveShotVideoCapabilitySupport,
} from './shotVideoPlan';
import { compileShotVideoGenerationRequest } from './videoGenerationRequests';
import { resolveConfiguredChannelModel } from '../providers/channel/resolver';
import { getModelMaxReferenceImages } from '../providers/itv/modelCatalog';
import type { StyleSnapshotLike } from '../utils/promptNormalize';
import { normalizeVideoDurationSeconds } from '../utils/videoDuration';
import { clampDurationToSpec, getDurationSpecForITVSelection } from '../providers/itv/durationSpec';

const logger = createLogger('ShotRender');

interface ShotRenderParams {
  projectId: string;
  episodeId?: string;
  shot: Shot;
  settings?: AppSettings;
  aspectRatio?: '16:9' | '9:16';
  mediaSelections?: {
    ttiSelection?: string;
    itvSelection?: string;
    ttsSelection?: string;
  };
  theme?: string;
  stylePrompt?: string;
  styleSnapshot?: StyleSnapshotLike;
  allShots?: Shot[];
  project?: { styleSnapshot?: StyleSnapshotLike; aspectRatio?: '16:9' | '9:16'; mode?: 'drama' | 'narration' };
}

interface ShotRenderResult {
  shotId: string;
  version: ShotVersion;
  success: boolean;
  error?: string;
}

interface BatchRenderParams {
  projectId: string;
  episodeId?: string;
  shots: Shot[];
  settings?: AppSettings;
  aspectRatio?: '16:9' | '9:16';
  mediaSelections?: {
    ttiSelection?: string;
    itvSelection?: string;
    ttsSelection?: string;
  };
  theme?: string;
  stylePrompt?: string;
  styleSnapshot?: StyleSnapshotLike;
  allShots?: Shot[];
  project?: { styleSnapshot?: StyleSnapshotLike; aspectRatio?: '16:9' | '9:16'; mode?: 'drama' | 'narration' };
  concurrency?: number;
  onShotComplete?: (result: ShotRenderResult) => void | Promise<void>;
}

interface BatchRenderResult {
  total: number;
  success: number;
  failed: number;
  results: ShotRenderResult[];
}

/**
 * 分镜视频生成工作流
 * 只调用 ITV，不生成图片
 */
export async function shotRenderWorkflow(
  params: ShotRenderParams,
  onProgress: (progress: number, step?: string) => void
): Promise<ShotRenderResult> {
  const { projectId, episodeId, shot, settings, mediaSelections } = params;
  const normalizedShot = normalizeShotMediaState(shot);
  const sourceVideoPrompt = (normalizedShot.videoPrompt || '').trim();
  if (!sourceVideoPrompt) {
    logger.warn('分镜视频生成被阻止：视频提示词为空', { shotId: normalizedShot.id });
    return {
      shotId: normalizedShot.id,
      version: {} as ShotVersion,
      success: false,
      error: '请先填写视频提示词',
    };
  }
  const episodeShots = params.allShots
    ?? (episodeId ? await loadEpisodeShots(projectId, episodeId).catch(() => undefined) : undefined);

  logger.info(`开始生成分镜视频 ${normalizedShot.id}`);

  let itvProviderName = 'unknown';

  // 加载角色数据（用于构建 prompt）
  let characters: Character[] = [];
  try {
    characters = normalizeCharactersMediaState(await loadCharacters(projectId));
  } catch {
    // 忽略
  }

  const videoPlan = collectShotVideoPlan({
    shot: normalizedShot,
    characters,
    scenes: [],
    props: [],
    allShots: episodeShots,
  });

  try {
    // 加载道具
    let projectProps: Prop[] = [];
    try {
      projectProps = normalizePropsMediaState(await loadProps(projectId));
    } catch {
      // 忽略
    }

    let projectScenes: Scene[] = normalizeScenesMediaState([]);
    try {
      projectScenes = normalizeScenesMediaState(await loadScenes(projectId));
    } catch {
      // 忽略
    }

    const initialVideoPlan = collectShotVideoPlan({
      shot: normalizedShot,
      characters,
      scenes: projectScenes,
      props: projectProps,
      allShots: episodeShots,
    });
    const selectedItvContext = settings
      ? resolveConfiguredChannelModel(settings, 'itv', mediaSelections?.itvSelection, initialVideoPlan.capability)
      : undefined;
    const selectedItvModelCapabilities = selectedItvContext?.model.capabilities;
    const selectedItvModelMaxRefs = getModelMaxReferenceImages(
      selectedItvContext?.model,
      selectedItvContext?.channelConfig.providerType,
    );
    const resolvedVideoPlan = collectShotVideoPlan({
      shot: normalizedShot,
      characters,
      scenes: projectScenes,
      props: projectProps,
      allShots: episodeShots,
      modelCapabilities: selectedItvModelCapabilities,
      modelMaxRefs: selectedItvModelMaxRefs,
    });
    const capabilitySupport = settings
      ? resolveShotVideoCapabilitySupport({
          settings,
          selectionKey: mediaSelections?.itvSelection,
          capability: resolvedVideoPlan.capability,
          visualInputCount: resolvedVideoPlan.visualReferenceInputs.length,
        })
      : undefined;
    logger.info('分镜视频模型选择解析', {
      shotId: normalizedShot.id,
      requestedSelection: mediaSelections?.itvSelection,
      requestedCapability: resolvedVideoPlan.capability,
      selectedModelCapabilities: selectedItvModelCapabilities,
      resolvedSelection: capabilitySupport?.effectiveSelectionKey,
      resolvedModelId: capabilitySupport?.resolvedContext?.model.id,
      resolvedCapabilities: capabilitySupport?.resolvedContext?.model.capabilities,
      disabledReason: capabilitySupport?.disabledReason,
    });
    if (capabilitySupport?.disabledReason) {
      throw new Error(capabilitySupport.disabledReason);
    }
    if (capabilitySupport?.resolvedContext) {
      itvProviderName = `${capabilitySupport.resolvedContext.definition.name} / ${capabilitySupport.resolvedContext.model.label}`;
    }
    const effectiveVideoCapability = capabilitySupport?.capability || resolvedVideoPlan.capability;
    const effectiveCapabilityLabel = capabilitySupport?.capabilityLabel || resolvedVideoPlan.capabilityLabel;
    const effectiveITVSelection = capabilitySupport?.effectiveSelectionKey || mediaSelections?.itvSelection;

    logger.info('分镜视频能力推断', {
      shotId: normalizedShot.id,
      requestedCapability: videoPlan.capability,
      effectiveCapability: effectiveVideoCapability,
      effectiveCapabilityLabel,
      selectedImage: Boolean(resolvedVideoPlan.selectedImageAsset),
      primaryImage: Boolean(resolvedVideoPlan.primaryImageInput),
      visualReferences: resolvedVideoPlan.visualReferenceInputs.length,
      additionalReferences: resolvedVideoPlan.additionalReferenceImages.length,
      itvSelection: effectiveITVSelection,
    });

    // 视频生成只能使用用户在分镜编辑器中看到的 videoPrompt。
    // 空 prompt 在入口处已拒绝，不再隐式套用 itv_shot_video 默认模板，避免发送"看不见的提示词"。
    let videoPrompt = sanitizeVideoPromptResult(sourceVideoPrompt);
    let templateId = 'shot.videoPrompt';
    let promptSource: 'default' | 'custom' | 'finalized' = 'finalized';

    const shotCharacterNames = (normalizedShot.characters || [])
      .map(charId => characters.find(char => char.id === charId)?.name)
      .filter((name): name is string => Boolean(name));
    videoPrompt = shouldPatchShotDialogue(videoPrompt)
      ? ensureExplicitDialogueInVideoPrompt(
          videoPrompt,
          String(normalizedShot.dialogue || ''),
          shotCharacterNames,
          normalizeProjectNarrativeMode(params.project?.mode),
        )
      : videoPrompt;

    const providerType = capabilitySupport?.resolvedContext?.definition.runtimeProviderType
      || capabilitySupport?.resolvedContext?.channelConfig.providerType;
    const videoDuration = settings
      ? clampDurationToSpec(
          normalizedShot.duration,
          getDurationSpecForITVSelection(effectiveITVSelection, settings.channelConfigs || []),
        )
      : normalizeVideoDurationSeconds(normalizedShot.duration);
    const compiledVideoRequest = compileShotVideoGenerationRequest({
      plan: resolvedVideoPlan,
      prompt: videoPrompt,
      duration: videoDuration,
      motionPrompt: normalizedShot.cameraMovement,
      aspectRatio: params.aspectRatio || params.project?.aspectRatio || '16:9',
      capability: effectiveVideoCapability,
      providerType,
    });
    const providerSideReferenceCount = isImageToVideoRequest(compiledVideoRequest.request)
      ? (compiledVideoRequest.request.additionalReferences || []).length
      : isReferenceToVideoRequest(compiledVideoRequest.request)
        ? Math.max(0, compiledVideoRequest.request.referenceImages.length - 1)
        : 0;

    logger.info(`视频 prompt: ${compiledVideoRequest.prompt}`);
    if (providerSideReferenceCount > 0) {
      logger.info('额外参考图', {
        count: providerSideReferenceCount,
        capability: effectiveVideoCapability,
        providerType: providerType || 'unknown',
      });
    }

    // 打印 ITV 调用日志（这里记录的是“原始来源”，实际传入 Provider 前会被 resolver 规范化）
    logITVCall(
      itvProviderName,
      resolvedVideoPlan.primaryImageSource
        || getMediaAssetDisplaySource(resolvedVideoPlan.additionalReferenceImages[0] as any)
        || String(resolvedVideoPlan.additionalReferenceImages[0] || ''),
      compiledVideoRequest.prompt,
      {
        duration: videoDuration,
        motionPrompt: normalizedShot.cameraMovement,
        capability: effectiveVideoCapability,
      },
      {
        projectId,
        targetId: normalizedShot.id,
        targetName: `分镜视频: ${normalizedShot.id}`,
        templateId,
        promptSource,
      }
    );

    // 先创建版本（生成后续媒体时用 versionId 做落盘路径收口）
    onProgress(20, '创建分镜版本...');
    const baseVersion = await saveShotVersion(projectId, normalizedShot.id, {
      media: {
        image: resolvedVideoPlan.selectedImageAsset,
      },
      prompt: compiledVideoRequest.prompt,
      seed: normalizedShot.seed || Math.floor(Math.random() * 1000000),
      model: itvProviderName,
    });
    const versionId = `v${baseVersion.version}`;

    // 生成视频只负责 ITV，不触发 TTS。配音应由独立音频/配音流程处理。
    onProgress(30, `生成${effectiveCapabilityLabel}...`);

    await mediaGenerationService.generateVideo({
      projectId,
      ownerRef: {
        projectId,
        ownerType: 'shot-version',
        ownerId: normalizedShot.id,
        slot: 'video',
        episodeId,
        versionId,
      },
      request: compiledVideoRequest.request,
      itvSelection: effectiveITVSelection,
      taskName: `分镜视频: ${normalizedShot.id}`,
      allowCapabilityFallback: false,
    });
    onProgress(95, `${effectiveCapabilityLabel}完成`);

    // reload: MediaGenerationService 绑定会直接写 shot.json
    const meta = await loadShotMeta(projectId, normalizedShot.id);
    const version = meta?.versions?.find(v => v.version === baseVersion.version) || baseVersion;

    logger.info(`分镜 ${normalizedShot.id} 视频生成完成，版本 ${version.version}`);
    onProgress(100, '完成');

    return {
      shotId: normalizedShot.id,
      version,
      success: true,
    };
  } catch (err: any) {
    logger.error(`分镜 ${normalizedShot.id} 视频生成失败`, { error: err.message });
    return {
      shotId: normalizedShot.id,
      version: {} as ShotVersion,
      success: false,
      error: err.message,
    };
  }
}

/**
 * 批量生成视频
 */
export async function batchRenderShots(
  params: BatchRenderParams,
  onProgress: (overall: number, current: { shotId: string; progress: number; step?: string }) => void
): Promise<BatchRenderResult> {
  const {
    projectId,
    episodeId,
    shots,
    settings,
    aspectRatio,
    mediaSelections,
    theme,
    stylePrompt,
    styleSnapshot,
    allShots,
    project,
    concurrency: _concurrency = 1,
    onShotComplete,
  } = params;

  logger.info(`开始批量生成 ${shots.length} 个分镜视频`);

  const results: ShotRenderResult[] = [];
  let completed = 0;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];

    let result: ShotRenderResult;
    try {
      result = await shotRenderWorkflow(
        { projectId, episodeId, shot, settings, aspectRatio, mediaSelections, theme, stylePrompt, styleSnapshot, allShots, project },
        (progress, step) => {
          const overall = Math.round(((completed + progress / 100) / shots.length) * 100);
          onProgress(overall, { shotId: shot.id, progress, step });
        }
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('批量分镜视频单项异常，继续后续分镜', {
        shotId: shot.id,
        error,
      });
      result = {
        shotId: shot.id,
        version: {} as ShotVersion,
        success: false,
        error,
      };
    }

    results.push(result);
    completed++;

    const overall = Math.round((completed / shots.length) * 100);
    onProgress(overall, { shotId: shot.id, progress: 100, step: result.success ? '完成' : '失败' });
    if (onShotComplete) {
      try {
        await onShotComplete(result);
      } catch (err) {
        logger.warn('批量分镜视频单项完成回调失败', {
          shotId: shot.id,
          success: result.success,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.filter((r) => !r.success).length;

  logger.info(`批量生成完成: ${successCount} 成功, ${failedCount} 失败`);

  return {
    total: shots.length,
    success: successCount,
    failed: failedCount,
    results,
  };
}

// ========== 辅助函数 ==========

function shouldPatchShotDialogue(prompt: string): boolean {
  const dialogueLine = prompt
    .split(/\r?\n/)
    .find(line => /^\s*对白提示词\s*[:：]/.test(line));
  if (!dialogueLine) return true;
  const value = dialogueLine.replace(/^\s*对白提示词\s*[:：]\s*/, '').trim();
  return !value || value === '无';
}

export default {
  shotRenderWorkflow,
  batchRenderShots,
};
