import type {
  AsyncTask,
  AsyncTaskTargetType,
  ITVRequest,
  MediaAssetSource,
  MediaKind,
  MediaOwnerRef,
  ProviderAssetInput,
  StoredMediaAsset,
  TTIRequest,
  TTSRequest,
} from '../types';
import {
  isImageToVideoRequest,
  isReferenceToVideoRequest,
  isTextToVideoRequest,
} from '../types';
import { createLogger } from '../store/logger';
import { loadSettings } from '../store/globalStore';
import { resolveProviderAssetInput } from './mediaAssetResolver';
import { runWithConcurrency } from '../utils/concurrency';
import { persistMediaAsset } from './mediaPersistenceService';
import { bindOwnerRefMedia } from './mediaTaskBindingService';
import { submitTask, waitForTaskCompletion } from './tasksIPC';
import { getProjectITVProvider, getProjectTTIProvider, getProjectTTSProvider } from '../providers';
import type { VideoGenerationCapability } from '../types';
import { taskHandlerRegistry } from './taskHandlerRegistry';
import './taskHandlers'; // 副作用 import：注册内置 TTI/ITV/TTS 任务处理器
import {
  listConfiguredModelSelectOptions,
  resolveConfiguredChannelModel,
  resolveConfiguredChannelModelWithCapabilityFallback,
  serializeMediaSelection,
  type ResolvedChannelModelContext,
} from '../providers/channel/resolver';
import type { MediaCategory, ModelCapability } from '../providers/channel/types';
import type { ImageResult } from '../providers/tti/types';
import {
  ensureRemoteUrlForImageAsset,
} from './mediaRemoteUrlService';
import type { PromptCompilationInput } from './promptCompilation/types';
import { compileGrokTTI } from './promptCompilation/grokImageIndexCompiler';
import {
  compileWorkflowVideoDomainRequest,
  getPromptProtocol,
  mapVideoRequestToProviderRequest,
  resolveITVTransportSupport,
  resolveVideoProtocolCompilationLimit,
} from './promptCompilation/videoRequestCompiler';
import { parseMentions } from '../editor/mentionTypes';
import { sanitizeBodyForLog, truncateString } from '../utils/logFormatting';
import {
  createVideoTraceContext,
  summarizeVideoRequestForLog,
  withVideoTrace,
} from '../utils/videoGenerationTrace';
import { getProjectPath } from '../store/projectStore';

const logger = createLogger('MediaGeneration');

function buildExecutionMetadata(
  context: ResolvedChannelModelContext | undefined,
  capability: ModelCapability,
) {
  return {
    channelId: context?.channelConfig.id,
    modelId: context?.model.id,
    capability,
  };
}

const CAPABILITY_LABELS: Partial<Record<ModelCapability, string>> = {
  'llm.chat': '对话',
  'image.text-to-image': '文生图',
  'image.image-to-image': '图生图',
  'video.text-to-video': '文生视频',
  'video.image-to-video': '图生视频',
  'video.reference-to-video': '参考生视频',
  'video.start-end-to-video': '首尾帧视频',
  'speech.text-to-speech': '语音合成',
};

function buildMissingCapabilityError(params: {
  category: MediaCategory;
  capability: ModelCapability;
  selectionKey?: string;
  hasCapableModels: boolean;
  fallbackMessage: string;
}): string {
  const capabilityLabel = CAPABILITY_LABELS[params.capability] || params.capability;
  if (params.hasCapableModels && params.selectionKey) {
    return `当前选择的模型不支持${capabilityLabel}，请切换模型`;
  }
  if (!params.hasCapableModels) {
    return `当前没有配置支持${capabilityLabel}的模型`;
  }
  return params.fallbackMessage;
}

async function resolveProviderAndContext<T>(params: {
  category: MediaCategory;
  selectionKey?: string;
  capability: ModelCapability;
  getProvider: (
    selectionKey?: string,
    capability?: ModelCapability,
    settingsSnapshot?: Awaited<ReturnType<typeof loadSettings>>,
  ) => Promise<T | null>;
  missingError: string;
  allowCapabilityFallback?: boolean;
}): Promise<{ provider: T; resolvedContext?: ResolvedChannelModelContext }> {
  let resolvedContext: ResolvedChannelModelContext | undefined;
  let resolvedSelectionKey = params.selectionKey;
  let capabilityError: string | undefined;
  let settingsSnapshot: Awaited<ReturnType<typeof loadSettings>> | undefined;
  try {
    const canReadSettings = typeof window !== 'undefined'
      ? typeof window.localStorage !== 'undefined'
      : typeof localStorage !== 'undefined';
    if (canReadSettings) {
      const settings = await loadSettings();
      settingsSnapshot = settings;
      const resolved = params.allowCapabilityFallback
        ? resolveConfiguredChannelModelWithCapabilityFallback(
            settings,
            params.category,
            params.selectionKey,
            params.capability,
          )
        : {
            context: resolveConfiguredChannelModel(
              settings,
              params.category,
              params.selectionKey,
              params.capability,
            ),
            effectiveSelectionKey: params.selectionKey,
          };
      resolvedContext = resolved.context;
      resolvedSelectionKey = resolved.effectiveSelectionKey || resolvedSelectionKey;
      if (!resolvedContext) {
        const capableModels = listConfiguredModelSelectOptions(
          settings,
          params.category,
          params.capability,
        );
        capabilityError = buildMissingCapabilityError({
          category: params.category,
          capability: params.capability,
          selectionKey: params.selectionKey,
          hasCapableModels: capableModels.length > 0,
          fallbackMessage: params.missingError,
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to resolve media execution context metadata', {
      category: params.category,
      capability: params.capability,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const provider = await params.getProvider(
    resolvedSelectionKey,
    params.capability,
    settingsSnapshot,
  );
  if (!provider) {
    throw new Error(capabilityError || params.missingError);
  }

  return { provider, resolvedContext };
}

function inferTargetType(ownerRef: MediaOwnerRef): AsyncTaskTargetType {
  switch (ownerRef.ownerType) {
    case 'character':
      return 'character';
    case 'scene':
      return 'scene';
    case 'prop':
      return 'prop';
    case 'shot':
    case 'shot-version':
      return 'shot';
    default:
      return 'shot';
  }
}

async function ensureProviderAssetInput(
  source: MediaAssetSource | ProviderAssetInput | undefined
): Promise<ProviderAssetInput | undefined> {
  if (!source) return undefined;
  if (typeof source === 'object' && 'transport' in source && 'value' in source) {
    return source as ProviderAssetInput;
  }
  // TTI 参考图统一走 local-first：项目内角色/场景/道具/分镜的预览图都已落盘，
  // 没必要再让 provider 去远端拉一次（CSP / fs allowed-path / 速度都是问题）。
  // 只有当 asset 没有 localPath 时才退到 remote-url。
  return resolveProviderAssetInput(source as MediaAssetSource, { preferLocalFile: true });
}

async function ensureProviderAssetInputs(
  sources: Array<MediaAssetSource | ProviderAssetInput | undefined>
): Promise<ProviderAssetInput[]> {
  const resolved = await Promise.all(sources.map(ensureProviderAssetInput));
  return resolved.filter(Boolean) as ProviderAssetInput[];
}

function mergeMediaMetadata(
  base: StoredMediaAsset,
  patch: Partial<StoredMediaAsset>
): StoredMediaAsset {
  return {
    ...base,
    ...patch,
    metadata: {
      ...(base.metadata || {}),
      ...(patch.metadata || {}),
    },
  };
}

function durationSecToMs(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1000);
}

function getOptionNumber(
  options: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = options?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeImageSource(source: string | undefined): Record<string, unknown> {
  if (!source) return { present: false };
  if (source.startsWith('data:')) {
    return {
      present: true,
      kind: 'data-url',
      length: source.length,
      preview: truncateString(source, 120),
    };
  }
  return {
    present: true,
    kind: /^https?:\/\//i.test(source) ? 'remote-url' : 'path',
    value: truncateString(source, 500),
  };
}

function summarizeImageAsset(asset: StoredMediaAsset): Record<string, unknown> {
  return {
    kind: asset.kind,
    localPath: asset.localPath,
    remoteUrl: asset.remoteUrl,
    mimeType: asset.mimeType,
    provider: asset.provider,
    providerTaskId: asset.providerTaskId,
    channelId: asset.channelId,
    modelId: asset.modelId,
    width: asset.width,
    height: asset.height,
    capability: asset.capability,
  };
}

type ImageDestPathResolver = string | ((index: number, output: ImageResult) => string | undefined | Promise<string | undefined>);

async function buildVersionedVideoDestPath(
  projectId: string,
  ownerRef: MediaOwnerRef,
): Promise<string | undefined> {
  if (ownerRef.ownerType !== 'shot-version' || ownerRef.slot !== 'video' || !ownerRef.versionId) {
    return undefined;
  }
  const projectPath = await getProjectPath(projectId);
  return `${projectPath}/shots/${ownerRef.ownerId}/versions/${ownerRef.versionId}/video.mp4`;
}

function getImmediateImageOutputs(output: ImageResult): ImageResult[] {
  const batchImages = output.metadata?.batchImages;
  if (Array.isArray(batchImages) && batchImages.length > 0) {
    return batchImages;
  }
  return [output];
}

function appendImageIndexToPath(destPath: string, index: number): string {
  if (index <= 0) {
    return destPath;
  }
  const extensionIndex = destPath.lastIndexOf('.');
  const slashIndex = Math.max(destPath.lastIndexOf('/'), destPath.lastIndexOf('\\'));
  if (extensionIndex <= slashIndex) {
    return `${destPath}-${index + 1}`;
  }
  return `${destPath.slice(0, extensionIndex)}-${index + 1}${destPath.slice(extensionIndex)}`;
}

async function resolveImageDestPath(
  destPath: ImageDestPathResolver | undefined,
  index: number,
  output: ImageResult,
  total: number,
): Promise<string | undefined> {
  if (!destPath) {
    return undefined;
  }
  if (typeof destPath === 'function') {
    return destPath(index, output);
  }
  if (total <= 1) {
    return destPath;
  }
  return appendImageIndexToPath(destPath, index);
}

function resolveImageMetadata(params: {
  executionMetadata: ReturnType<typeof buildExecutionMetadata>;
  originalPrompt: string;
  protocol?: string;
  compiledPrompt?: string;
  compilationDebug?: any;
  optionWidth?: number;
  optionHeight?: number;
  optionSeed?: number;
  output: ImageResult;
  index: number;
  total: number;
}): Record<string, unknown> {
  const {
    executionMetadata,
    originalPrompt,
    protocol,
    compiledPrompt,
    compilationDebug,
    optionWidth,
    optionHeight,
    optionSeed,
    output,
    index,
    total,
  } = params;
  const resolvedSeed = output.seed ?? optionSeed;
  return {
    ...executionMetadata,
    prompt: originalPrompt,
    ...(protocol ? { promptProtocol: protocol } : undefined),
    ...(compilationDebug ? { compiledPrompt, compilationDebug } : undefined),
    ...(optionWidth ? { width: optionWidth } : undefined),
    ...(optionHeight ? { height: optionHeight } : undefined),
    ...(resolvedSeed !== undefined ? { seed: resolvedSeed } : undefined),
    ...(total > 1 ? { batchIndex: index, batchCount: total } : undefined),
    ...(output.metadata ? { providerOutput: output.metadata } : undefined),
  };
}

function resolveTaskSelectionKey(task: AsyncTask, fallbackSelection?: string): string | undefined {
  if (task.channelId && task.modelId) {
    return serializeMediaSelection({
      channelId: task.channelId,
      modelId: task.modelId,
    });
  }
  return fallbackSelection;
}

function resolveTaskCapability(task: AsyncTask): ModelCapability {
  if (task.capability) {
    return task.capability as ModelCapability;
  }
  return taskHandlerRegistry.get(task.type)?.defaultCapability ?? 'image.text-to-image';
}

export class MediaGenerationService {
  async generateImages(params: {
    projectId: string;
    ownerRef: MediaOwnerRef;
    request: TTIRequest<MediaAssetSource | ProviderAssetInput>;
    promptCompilation?: PromptCompilationInput;
    ttiSelection?: string;
    taskName?: string;
    destPath?: ImageDestPathResolver;
    bindOwner?: boolean;
    normalizeRemoteUrl?: boolean;
    /**
     * 进度回调：把 immediate 路径中"调用 provider / 下载 / 持久化 / 绑定"分阶段
     * 暴露给外层（runWithTask 的 ctx.progress / character workflow 的 onProgress）。
     * percent 是 [0,100] 范围。stage 仅日志用。
     */
    onProgress?: (percent: number, stage: string) => void;
  }): Promise<StoredMediaAsset[]> {
    const {
      projectId,
      ownerRef,
      request,
      ttiSelection,
      taskName,
      promptCompilation,
      destPath,
      bindOwner = true,
      normalizeRemoteUrl = true,
      onProgress,
    } = params;
    const { provider, resolvedContext } = await resolveProviderAndContext({
      category: 'tti',
      selectionKey: ttiSelection,
      capability: 'image.text-to-image',
      getProvider: (selectionKey, capability, settingsSnapshot) =>
        getProjectTTIProvider(selectionKey, capability as 'image.text-to-image' | 'image.image-to-image' | undefined, settingsSnapshot),
      missingError: '未配置 TTI 服务',
    });
    const executionMetadata = buildExecutionMetadata(resolvedContext, 'image.text-to-image');

    const protocol = getPromptProtocol(provider);
    logger.info('TTI generateImages entry', {
      ownerRef,
      provider: provider.config?.provider,
      protocol: protocol || 'none',
      count: request.count ?? 1,
      hasPromptCompilation: Boolean(promptCompilation?.selectedAssets?.length),
      referencesCount: (request.references || []).length,
    });
    const originalPrompt = request.prompt;
    let compiledPrompt = originalPrompt;
    let compilationDebug: any = null;
    let compileReferences = request.references || [];

    if (protocol === 'grok-image-index' && promptCompilation?.selectedAssets?.length) {
      const { compiledPrompt: cp, compiledReferences, debug } = compileGrokTTI({
        prompt: originalPrompt,
        selectedAssets: promptCompilation.selectedAssets,
        // Keep any manual refs as trailing extras (do not shift @Image N indices).
        extraReferences: (request.references || []),
      });
      compiledPrompt = cp;
      compilationDebug = debug;
      compileReferences = compiledReferences;

      logger.info('TTI prompt compiled (grok-image-index)', {
        ownerRef,
        protocol,
        originalPrompt: truncateString(originalPrompt, 800),
        compiledPrompt: truncateString(compiledPrompt, 800),
        mentions: parseMentions(originalPrompt),
        debug,
      });
    }

    let references: ProviderAssetInput[];
    try {
      references = await ensureProviderAssetInputs(compileReferences);
      logger.info('TTI references resolved', sanitizeBodyForLog({
        ownerRef,
        provider: provider.config?.provider,
        protocol: protocol || 'none',
        requestedReferences: compileReferences.length,
        resolvedReferences: references.map(r => ({ transport: r.transport, value: r.value, mimeType: r.mimeType })),
      }));
    } catch (error) {
      logger.error('TTI reference resolve failed', {
        ownerRef,
        provider: provider.config?.provider,
        protocol: protocol || 'none',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    logger.info('TTI provider.start payload', sanitizeBodyForLog({
      ownerRef,
      provider: provider.config?.provider,
      channelId: executionMetadata.channelId,
      modelId: executionMetadata.modelId,
      promptProtocol: protocol || 'none',
      prompt: compiledPrompt,
      count: request.count ?? 1,
      references: references.map(r => ({ transport: r.transport, value: r.value, mimeType: r.mimeType })),
      options: request.options,
    }));

    onProgress?.(15, '调用 provider');
    let started: Awaited<ReturnType<typeof provider.start>>;
    try {
      started = await provider.start({
        prompt: compiledPrompt,
        references,
        options: request.options,
        count: request.count,
      });
      onProgress?.(40, 'provider 已返回');
      logger.info('TTI provider.start succeeded', {
        ownerRef,
        provider: provider.config?.provider,
        mode: started.mode,
        requestedCount: request.count ?? 1,
        taskId: started.mode === 'async' ? started.taskId : (started.output as any).taskId,
        outputSource: started.mode === 'immediate'
          ? summarizeImageSource(started.output.url || started.output.path)
          : undefined,
        outputWidth: started.mode === 'immediate' ? started.output.width : undefined,
        outputHeight: started.mode === 'immediate' ? started.output.height : undefined,
      });
    } catch (error) {
      logger.error('TTI provider.start failed', {
        ownerRef,
        provider: provider.config?.provider,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        protocol: protocol || 'none',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const kind: MediaKind = 'image';
    const options = request.options as Record<string, unknown> | undefined;
    const optionWidth = getOptionNumber(options, 'width');
    const optionHeight = getOptionNumber(options, 'height');
    const optionSeed = getOptionNumber(options, 'seed');

    if (started.mode === 'immediate') {
      const outputs = getImmediateImageOutputs(started.output);

      logger.info('TTI immediate outputs resolved', {
        ownerRef,
        provider: provider.config?.provider,
        requestedCount: request.count ?? 1,
        outputCount: outputs.length,
      });

      // 串行 persist 在 batch=9 时是阻塞主路径的元凶：
      // 每张要 IPC 下载远端 URL + 写文件 + bindOwner SQLite。一张卡住整个循环不推进，
      // runWithTask 的外层 ctx.progress(100) 永远不调，任务卡 10%、UI 永远不展示。
      // 改成并发持久化（最多 4 路并行，避免一次性发起 9 个 IPC 抢占主线程）。
      const persistTasks = outputs.map((output, index) => async (): Promise<StoredMediaAsset> => {
        const source = output.url || output.path;
        if (!source) {
          logger.error('TTI immediate output missing source', {
            ownerRef,
            provider: provider.config?.provider,
            index,
            output: sanitizeBodyForLog(output as any),
          });
          throw new Error('图片生成完成但未返回结果地址');
        }
        const outputDestPath = await resolveImageDestPath(destPath, index, output, outputs.length);
        logger.info('TTI immediate persist start', {
          ownerRef,
          provider: provider.config?.provider,
          index,
          source: summarizeImageSource(source),
          destPath: outputDestPath,
        });
        const persisted = await persistMediaAsset({
          projectId,
          kind,
          source,
          destPath: outputDestPath,
          ownerRef,
          provider: provider.config?.provider,
          providerTaskId: (started.output as any).taskId,
          channelId: executionMetadata.channelId,
          modelId: executionMetadata.modelId,
          capability: executionMetadata.capability,
          metadata: resolveImageMetadata({
            executionMetadata,
            originalPrompt,
            protocol,
            compiledPrompt,
            compilationDebug,
            optionWidth,
            optionHeight,
            optionSeed,
            output,
            index,
            total: outputs.length,
          }),
        });
        logger.info('TTI immediate persisted', {
          ownerRef,
          index,
          asset: summarizeImageAsset(persisted),
        });

        const normalized = normalizeRemoteUrl
          ? await ensureRemoteUrlForImageAsset({
              projectId,
              asset: persisted,
              policy: 'best-effort',
            })
          : persisted;
        if (normalizeRemoteUrl) {
          logger.info('TTI immediate remote-url normalized', {
            ownerRef,
            index,
            before: summarizeImageAsset(persisted),
            after: summarizeImageAsset(normalized),
          });
        } else {
          logger.info('TTI immediate remote-url normalization skipped', {
            ownerRef,
            index,
            asset: summarizeImageAsset(persisted),
          });
        }

        return mergeMediaMetadata(normalized, {
          provider: provider.config?.provider,
          width: optionWidth ?? output.width ?? normalized.width,
          height: optionHeight ?? output.height ?? normalized.height,
        });
      });

      // 并发跑（最多 4 路），任一失败抛出（保留 Promise.all 语义）。
      // 失败时已 persist 的图保留在落盘目录里，下游决定是否清理。
      // 包一层 progress 反馈：每张完成都把进度往前推，避免外层 task 长时间停留在 40%。
      let completedCount = 0;
      const persistTasksWithProgress = persistTasks.map((task) => async () => {
        try {
          return await task();
        } finally {
          completedCount += 1;
          // 40% (provider 已返回) → 90% (全部 persist 完)
          const span = 90 - 40;
          const next = 40 + Math.round(span * (completedCount / outputs.length));
          onProgress?.(next, `持久化 ${completedCount}/${outputs.length}`);
        }
      });
      const settled = await runWithConcurrency(persistTasksWithProgress, 4);
      const finalAssets: StoredMediaAsset[] = [];
      const failures: Array<{ index: number; error: unknown }> = [];
      settled.forEach((res, index) => {
        if (res.status === 'fulfilled') {
          finalAssets.push(res.value);
        } else {
          failures.push({ index, error: res.reason });
        }
      });
      if (failures.length > 0) {
        logger.error('TTI immediate persist partial failure', {
          ownerRef,
          provider: provider.config?.provider,
          totalCount: outputs.length,
          successCount: finalAssets.length,
          failureCount: failures.length,
          firstError: failures[0].error instanceof Error
            ? failures[0].error.message
            : String(failures[0].error),
        });
        // 全失败抛错；部分成功只警告（保留已落盘的）
        if (finalAssets.length === 0) {
          throw failures[0].error instanceof Error
            ? failures[0].error
            : new Error(String(failures[0].error));
        }
      }

      if (finalAssets.length === 0) {
        throw new Error('图片生成完成但未返回结果地址');
      }

      logger.info('TTI immediate bind owner start', {
        ownerRef,
        assetCount: finalAssets.length,
        asset: summarizeImageAsset(finalAssets[0]),
      });
      if (bindOwner) {
        await bindOwnerRefMedia(projectId, ownerRef, finalAssets[0]);
        logger.info('TTI immediate bind owner done', {
          ownerRef,
          assetCount: finalAssets.length,
          asset: summarizeImageAsset(finalAssets[0]),
        });
      } else {
        logger.info('TTI immediate bind owner skipped', {
          ownerRef,
          assetCount: finalAssets.length,
          asset: summarizeImageAsset(finalAssets[0]),
        });
      }
      onProgress?.(100, '完成');
      return finalAssets;
    }

    if ((request.count ?? 1) > 1) {
      logger.warn('TTI async batch request fell back to single finalized asset handling', {
        ownerRef,
        provider: provider.config?.provider,
        requestedCount: request.count,
      });
    }

    logger.info('TTI async submit (main-driven polling)', {
      remoteTaskId: started.taskId,
      ownerRef,
      provider: provider.config?.provider,
      channelId: executionMetadata.channelId,
      modelId: executionMetadata.modelId,
    });

    const finalAsset = await this.pollAndFinalizeViaMain({
      projectId,
      kind,
      ownerRef,
      taskName: taskName || ((request.count ?? 1) > 1 ? '批量图片生成' : '图片生成'),
      remoteTaskId: started.taskId,
      selection: ttiSelection,
      ...executionMetadata,
      assetMetadataPatch: {
        provider: provider.config?.provider,
        providerTaskId: started.taskId,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: executionMetadata.capability,
        ...(optionWidth !== undefined ? { width: optionWidth } : undefined),
        ...(optionHeight !== undefined ? { height: optionHeight } : undefined),
        metadata: {
          ...executionMetadata,
          prompt: originalPrompt,
          ...(protocol ? { promptProtocol: protocol } : undefined),
          ...(compilationDebug ? { compiledPrompt, compilationDebug } : undefined),
          ...(optionSeed !== undefined ? { seed: optionSeed } : undefined),
          ...((request.count ?? 1) > 1 ? { batchCount: request.count } : undefined),
        },
      },
      bindOwner,
    });

    // asyncDestPath / normalizeRemoteUrl 已在 fulfiller 里固化处理 —— ITV 始终走 normalize；
    // TTI 也始终 normalize（这是 generateImages 的默认行为，旧实现也走这个分支）

    return [finalAsset];
  }

  async generateImage(params: {
    projectId: string;
    ownerRef: MediaOwnerRef;
    request: TTIRequest<MediaAssetSource | ProviderAssetInput>;
    promptCompilation?: PromptCompilationInput;
    ttiSelection?: string;
    taskName?: string;
    destPath?: string;
    bindOwner?: boolean;
    normalizeRemoteUrl?: boolean;
    onProgress?: (percent: number, stage: string) => void;
  }): Promise<StoredMediaAsset> {
    const assets = await this.generateImages({
      ...params,
      request: {
        ...params.request,
        count: params.request.count ?? 1,
      },
    });
    const firstAsset = assets[0];
    if (!firstAsset) {
      throw new Error('图片生成完成但未返回结果地址');
    }
    return firstAsset;
  }

  async generateVideo(params: {
    projectId: string;
    ownerRef: MediaOwnerRef;
    request: ITVRequest<MediaAssetSource | ProviderAssetInput>;
    promptCompilation?: PromptCompilationInput;
    itvSelection?: string;
    taskName?: string;
    destPath?: string;
    /**
     * @deprecated 视频渠道**降级零容忍**：用户选了哪个渠道就只用哪个，
     * capability 不匹配时直接报错让用户调整，不静默切到另一个能力更广的模型/渠道。
     * 该参数保留但默认 false；显式传 true 也会被忽略以维持安全行为。
     */
    allowCapabilityFallback?: boolean;
  }): Promise<StoredMediaAsset> {
    const {
      projectId,
      ownerRef,
      request,
      itvSelection,
      taskName,
      promptCompilation,
      destPath,
    } = params;
    // 视频渠道零容忍：永远关掉 capability fallback。
    const allowCapabilityFallback = false;
    const { provider, resolvedContext } = await resolveProviderAndContext({
      category: 'itv',
      selectionKey: itvSelection,
      capability: request.capability,
      getProvider: (selectionKey, capability, settingsSnapshot) =>
        getProjectITVProvider(selectionKey, capability as VideoGenerationCapability | undefined, settingsSnapshot),
      missingError: '未配置 ITV 服务',
      allowCapabilityFallback,
    });
    const executionMetadata = buildExecutionMetadata(resolvedContext, request.capability);
    const traceContext = createVideoTraceContext({
      prefix: 'itv',
      source: 'media-generation',
      operation: 'media.generate-video',
      debugBody: true,
    });

    const protocol = getPromptProtocol(provider);
    logger.info('ITV generateVideo entry', {
      traceId: traceContext.traceId,
      ownerRef,
      selectionKey: itvSelection,
      channelId: executionMetadata.channelId,
      modelId: executionMetadata.modelId,
      provider: provider.config?.provider,
      capability: request.capability,
      protocol: protocol || 'none',
      hasPromptCompilation: Boolean(promptCompilation?.selectedAssets?.length),
      visualInputCount: isTextToVideoRequest(request)
        ? 0
        : isImageToVideoRequest(request)
          ? 1 + (request.additionalReferences || []).length
          : isReferenceToVideoRequest(request)
            ? request.referenceImages.length
            : 2,
      request: summarizeVideoRequestForLog(request),
    });
    const originalPrompt = request.prompt;
    let compiledPrompt = originalPrompt;
    let compilationDebug: any = null;
    const maxAdditionalReferences = resolveVideoProtocolCompilationLimit({
      provider,
      protocol,
    });
    const compiledDomainRequest = compileWorkflowVideoDomainRequest({
      request,
      promptCompilation,
      protocol,
      maxAdditionalReferences,
    });
    compiledPrompt = compiledDomainRequest.compiledPrompt;
    compilationDebug = compiledDomainRequest.compilationDebug;

    logger.info('ITV domain request compiled', {
      traceId: traceContext.traceId,
      provider: provider.config?.provider,
      capability: request.capability,
      protocol: protocol || 'none',
      unresolvedMentions: compiledDomainRequest.unresolvedMentions,
      compiledPrompt: truncateString(compiledPrompt, 800),
      request: summarizeVideoRequestForLog(compiledDomainRequest.request),
      compilationDebug: compilationDebug ? sanitizeBodyForLog(compilationDebug) : undefined,
    });

    if (compilationDebug && protocol === 'grok-image-index') {
      logger.info('ITV prompt compiled (grok-image-index)', {
        traceId: traceContext.traceId,
        ownerRef,
        protocol,
        originalPrompt: truncateString(originalPrompt, 800),
        compiledPrompt: truncateString(compiledPrompt, 800),
        mentions: parseMentions(originalPrompt),
        debug: compilationDebug,
      });
    }

    const transportSupport = resolveITVTransportSupport(provider);
    logger.info('ITV transport support resolved', {
      traceId: traceContext.traceId,
      provider: provider.config?.provider,
      transportSupport,
    });
    const providerRequest = await mapVideoRequestToProviderRequest({
      projectId,
      request: compiledDomainRequest.request,
      transportSupport,
      maxAdditionalReferences,
      preferLocalAssetInput: provider.config?.provider === 'seedance',
      fallbackToSourceOnRequiredUploadFailure: false,
    });
    const tracedProviderRequest = withVideoTrace(providerRequest, traceContext);

    logger.info('ITV provider request mapped', {
      traceId: traceContext.traceId,
      provider: provider.config?.provider,
      capability: tracedProviderRequest.capability,
      promptProtocol: protocol || 'none',
      request: summarizeVideoRequestForLog(tracedProviderRequest),
    });

    let started: Awaited<ReturnType<typeof provider.start>>;
    try {
      started = await provider.start(tracedProviderRequest as any);
    } catch (error) {
      logger.error('ITV provider.start failed', {
        traceId: traceContext.traceId,
        ownerRef,
        selectionKey: itvSelection,
        provider: provider.config?.provider,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: request.capability,
        protocol: protocol || 'none',
        error: error instanceof Error ? error.message : String(error),
        originalRequest: summarizeVideoRequestForLog(request),
        compiledRequest: summarizeVideoRequestForLog(compiledDomainRequest.request),
        providerRequest: summarizeVideoRequestForLog(tracedProviderRequest),
      });
      throw error;
    }

    logger.info('ITV provider.start succeeded', {
      traceId: traceContext.traceId,
      provider: provider.config?.provider,
      capability: request.capability,
      mode: started.mode,
      taskId: started.mode === 'async' ? started.taskId : started.output.taskId,
      immediateSource: started.mode === 'immediate' ? started.output.source : undefined,
    });

    const kind: MediaKind = 'video';
    const options = request.options as Record<string, unknown> | undefined;
    const optionDuration = getOptionNumber(options, 'duration');
    const resolvedDestPath = destPath ?? await buildVersionedVideoDestPath(projectId, ownerRef);

    if (started.mode === 'immediate') {
      const output = started.output;
      const source = (output as any).source;
      const persisted = await persistMediaAsset({
        projectId,
        kind,
        source,
        destPath: resolvedDestPath,
        ownerRef,
        provider: provider.config?.provider,
        providerTaskId: (output as any).taskId,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: executionMetadata.capability,
        metadata: {
          ...executionMetadata,
          capability: request.capability,
          prompt: originalPrompt,
          ...(protocol ? { promptProtocol: protocol } : undefined),
          ...(compilationDebug ? { compiledPrompt, compilationDebug } : undefined),
          ...(optionDuration ? { durationSec: optionDuration } : undefined),
        },
      });
      const finalAsset = mergeMediaMetadata(persisted, {
        provider: provider.config?.provider,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: executionMetadata.capability,
        durationMs: durationSecToMs(optionDuration) ?? persisted.durationMs,
        metadata: {
          ...executionMetadata,
          capability: request.capability,
          prompt: originalPrompt,
          ...(protocol ? { promptProtocol: protocol } : undefined),
          ...(compilationDebug ? { compiledPrompt, compilationDebug } : undefined),
        },
      });
      logger.info('ITV immediate result persisted', {
        traceId: traceContext.traceId,
        ownerRef,
        source,
        provider: provider.config?.provider,
      });
      await bindOwnerRefMedia(projectId, ownerRef, finalAsset);
      return finalAsset;
    }

    logger.info('ITV async submit (main-driven polling)', {
      traceId: traceContext.traceId,
      remoteTaskId: started.taskId,
      ownerRef,
      provider: provider.config?.provider,
    });

    return this.pollAndFinalizeViaMain({
      projectId,
      kind,
      ownerRef,
      taskName: taskName || '视频生成',
      remoteTaskId: started.taskId,
      selection: itvSelection,
      destPath: resolvedDestPath,
      ...executionMetadata,
      assetMetadataPatch: {
        provider: provider.config?.provider,
        providerTaskId: started.taskId,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: executionMetadata.capability,
        ...(durationSecToMs(optionDuration) !== undefined
          ? { durationMs: durationSecToMs(optionDuration) }
          : undefined),
        metadata: {
          ...executionMetadata,
          prompt: originalPrompt,
          ...(protocol ? { promptProtocol: protocol } : undefined),
          ...(compilationDebug ? { compiledPrompt, compilationDebug } : undefined),
        },
      },
    });
  }

  async generateAudio(params: {
    projectId: string;
    ownerRef: MediaOwnerRef;
    request: TTSRequest;
    ttsSelection?: string;
    taskName?: string;
  }): Promise<StoredMediaAsset> {
    const { projectId, ownerRef, request, ttsSelection, taskName } = params;
    const { provider, resolvedContext } = await resolveProviderAndContext({
      category: 'tts',
      selectionKey: ttsSelection,
      capability: 'speech.text-to-speech',
      getProvider: (selectionKey, _capability, settingsSnapshot) =>
        getProjectTTSProvider(selectionKey, 'speech.text-to-speech', settingsSnapshot),
      missingError: '未配置 TTS 服务',
    });
    const executionMetadata = buildExecutionMetadata(resolvedContext, 'speech.text-to-speech');

    const started = await provider.start(request as any);
    const kind: MediaKind = 'audio';

    if (started.mode === 'immediate') {
      const output = started.output;
      const persisted = await persistMediaAsset({
        projectId,
        kind,
        source: output.path,
        ownerRef,
        provider: provider.config?.provider,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: executionMetadata.capability,
        metadata: {
          ...executionMetadata,
          voiceId: request.voiceId,
        },
      });

      const finalAsset = mergeMediaMetadata(persisted, {
        provider: provider.config?.provider,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: executionMetadata.capability,
        durationMs: durationSecToMs(output.duration) ?? persisted.durationMs,
        mimeType: output.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
      });

      await bindOwnerRefMedia(projectId, ownerRef, finalAsset);
      return finalAsset;
    }

    return this.pollAndFinalizeViaMain({
      projectId,
      kind,
      ownerRef,
      taskName: taskName || '语音合成',
      remoteTaskId: started.taskId,
      selection: ttsSelection,
      ...executionMetadata,
      assetMetadataPatch: {
        provider: provider.config?.provider,
        providerTaskId: started.taskId,
        channelId: executionMetadata.channelId,
        modelId: executionMetadata.modelId,
        capability: executionMetadata.capability,
        metadata: {
          ...executionMetadata,
          voiceId: request.voiceId,
        },
      },
    });
  }

  async recoverTask(params: {
    projectId: string;
    task: AsyncTask;
    ttiSelection?: string;
    itvSelection?: string;
    ttsSelection?: string;
    /** @deprecated 进度现在通过 main 广播；UI 用 useTasks/useActiveTask 投影 */
    onProgress?: (task: AsyncTask, progress: number) => void;
  }): Promise<StoredMediaAsset | null> {
    const { projectId, task, ttiSelection, itvSelection, ttsSelection } = params;
    if (!task.remoteTaskId) return null;
    if (!task.ownerRef) {
      logger.warn('recoverTask: 任务缺少 ownerRef，跳过');
      return null;
    }

    const handler = taskHandlerRegistry.get(task.type);
    if (!handler) throw new Error(`未知任务类型: ${task.type}`);

    const kind = handler.kind;
    const taskCapability = resolveTaskCapability(task);

    const selectionByKind: Record<MediaKind, string | undefined> = {
      image: ttiSelection,
      video: itvSelection,
      audio: ttsSelection,
    };
    const handlerSelection = resolveTaskSelectionKey(task, selectionByKind[kind]);

    return this.pollAndFinalizeViaMain({
      projectId,
      kind,
      ownerRef: task.ownerRef,
      taskName: task.targetName || `恢复任务 ${task.id}`,
      remoteTaskId: task.remoteTaskId,
      selection: handlerSelection,
      channelId: task.channelId,
      modelId: task.modelId,
      capability: taskCapability,
      assetMetadataPatch: {
        providerTaskId: task.remoteTaskId,
        channelId: task.channelId,
        modelId: task.modelId,
        capability: task.capability,
      },
    });
  }

  /**
   * 主进程主导的轮询：submitTask 进 main 队列；handler 通过 delegateToRenderer
   * 反向调 renderer 的 provider.getTaskSnapshot 与 persistMediaAsset。
   *
   * 不再需要传 getSnapshot / extractSource / enrichAsset 闭包 ——
   * 这些都在 fulfiller 里通过 taskHandlerRegistry 反查。caller 只传可序列化数据。
   *
   * 关窗口/切项目都不会让 polling 挂掉（main 状态权威）。
   */
  private async pollAndFinalizeViaMain(params: {
    projectId: string;
    kind: MediaKind;
    ownerRef: MediaOwnerRef;
    taskName: string;
    remoteTaskId: string;
    selection?: string;
    channelId?: string;
    modelId?: string;
    capability?: string;
    /** 业务侧 enrichAsset 固化为可序列化 metadata patch（数据，无闭包） */
    assetMetadataPatch?: Partial<StoredMediaAsset>;
    bindOwner?: boolean;
    destPath?: string;
  }): Promise<StoredMediaAsset> {
    const handler = taskHandlerRegistry.findByKind(params.kind);
    if (!handler) throw new Error(`未知 kind: ${params.kind}`);
    const rendererHandlerType = handler.type as 'tti' | 'itv' | 'tts';
    const resolvedDestPath = params.destPath
      ?? (params.kind === 'video' ? await buildVersionedVideoDestPath(params.projectId, params.ownerRef) : undefined);

    const submitted = await submitTask({
      type: rendererHandlerType,
      scope: `project:${params.projectId}`,
      targetKind: inferTargetType(params.ownerRef),
      targetId: params.ownerRef.ownerId,
      input: {
        kind: params.kind,
        remoteTaskId: params.remoteTaskId,
        rendererHandlerType,
        channelId: params.channelId,
        modelId: params.modelId,
        capability: params.capability,
        selection: params.selection,
        ownerRef: params.ownerRef,
        projectId: params.projectId,
        extra: {
          assetMetadataPatch: params.assetMetadataPatch,
          bindOwner: params.bindOwner ?? true,
          destPath: resolvedDestPath,
        },
      },
      initialPayload: {
        // TaskStatusBar 直接读 payload.targetName，按 ManagerTask 形状对齐
        targetName: params.taskName,
        ownerRef: params.ownerRef,
        remoteTaskId: params.remoteTaskId,
        channelId: params.channelId,
        modelId: params.modelId,
        capability: params.capability,
      },
    });
    const final = await waitForTaskCompletion(submitted.id);
    const asset = (final.payload as { output?: StoredMediaAsset } | undefined)?.output;
    if (!asset) throw new Error('任务完成但缺少结果资产');
    return asset;
  }

}

export const mediaGenerationService = new MediaGenerationService();
