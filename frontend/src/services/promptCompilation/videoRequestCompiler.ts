import type { ITVRequest, MediaAssetSource, ProviderAssetInput, VideoGenerationCapability } from '../../types';
import {
  isImageToVideoRequest,
  isReferenceToVideoRequest,
  isStartEndToVideoRequest,
  isTextToVideoRequest,
} from '../../types';
import { isAssetMentionType, parseMentions } from '../../editor/mentionTypes';
import { resolveProviderAssetInput } from '../mediaAssetResolver';
import { compileGrokITV, compileGrokTTI } from './grokImageIndexCompiler';
import { compilePromptReferences } from './promptReferenceCompiler';
import type { PromptCompilationDebug, PromptCompilationInput } from './types';
import { DEFAULT_VIDEO_DURATION_SECONDS } from '../../utils/videoDuration';
import { clampDurationToSpec, type VideoDurationSpec } from '../../providers/itv/durationSpec';

type VideoRequestAsset = MediaAssetSource | ProviderAssetInput;
type ProviderAssetTransport = ProviderAssetInput['transport'];

interface ITVProviderTransportConfig {
  primaryImage?: ReadonlyArray<ProviderAssetTransport>;
  additionalReferences?: ReadonlyArray<ProviderAssetTransport>;
  referenceImages?: ReadonlyArray<ProviderAssetTransport>;
  startFrame?: ReadonlyArray<ProviderAssetTransport>;
  endFrame?: ReadonlyArray<ProviderAssetTransport>;
}

interface ITVProviderLike {
  config?: Record<string, unknown>;
  assetTransports?: ITVProviderTransportConfig;
}

export interface CompileVideoRequestResult<TAsset = VideoRequestAsset> {
  request: ITVRequest<TAsset>;
  unresolvedMentions: string[];
}

export interface ITVTransportSupport {
  primary: boolean;
  additional: boolean;
  reference: boolean;
  start: boolean;
  end: boolean;
}

export interface VideoRequestCompileResult {
  request: ITVRequest<VideoRequestAsset>;
  compiledPrompt: string;
  unresolvedMentions: string[];
  compilationDebug?: PromptCompilationDebug;
}

export interface VideoMappingMessageOverrides {
  missingPrimaryImage?: string;
  missingReferenceImages?: string;
  missingStartEndFrames?: string;
  remotePrimary?: string;
  remoteAdditional?: string;
  remoteReference?: string;
  remoteStart?: string;
  remoteEnd?: string;
}

const DEFAULT_REMOTE_ONLY_ERROR = '当前 ITV Provider 仅支持 URL 图片输入（remote-url），请启用图床以获得 remoteUrl';

function supportsVisualReferenceCompilation(capability: VideoGenerationCapability): boolean {
  return capability !== 'video.text-to-video';
}

function buildSelectedAssetMatchIds(
  type: string,
  assetId: string,
  altIds?: string[],
): Set<string> {
  const ids = new Set<string>();

  const add = (id?: string) => {
    if (!id) return;
    ids.add(id);
    const prefix = `${type}_`;
    if (id.startsWith(prefix)) {
      ids.add(id.slice(prefix.length));
    }
  };

  add(assetId);
  for (const alt of altIds || []) {
    add(alt);
  }

  return ids;
}

function compileReadableSelectedAssetMentions(params: {
  prompt: string;
  selectedAssets: NonNullable<PromptCompilationInput['selectedAssets']>;
}): string {
  const mentions = parseMentions(params.prompt);
  if (!mentions.length) {
    return params.prompt;
  }

  const replacements = mentions.map(mention => {
    if (!isAssetMentionType(mention.type)) {
      return null;
    }
    const hit = params.selectedAssets.find(asset => {
      if (asset.type !== mention.type) {
        return false;
      }
      return buildSelectedAssetMatchIds(asset.type, asset.assetId, asset.altIds).has(mention.id);
    });
    if (!hit) {
      return null;
    }

    const replacement = String(hit.textValue || hit.name || '').trim();
    if (!replacement) {
      return null;
    }

    return {
      from: mention.from,
      to: mention.to,
      replacement,
    };
  }).filter(Boolean) as Array<{ from: number; to: number; replacement: string }>;

  if (!replacements.length) {
    return params.prompt;
  }

  let compiledPrompt = params.prompt;
  for (const item of replacements.sort((left, right) => right.from - left.from)) {
    compiledPrompt = compiledPrompt.slice(0, item.from) + item.replacement + compiledPrompt.slice(item.to);
  }

  return compiledPrompt;
}

function supportsDataUrl(transports: ReadonlyArray<ProviderAssetTransport> | undefined): boolean {
  return Boolean(transports?.includes('data-url'));
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function coerceVideoDurationOption(value: unknown): number {
  const parsed = toPositiveInt(value);
  return parsed ?? DEFAULT_VIDEO_DURATION_SECONDS;
}

async function ensureProviderAssetInput(
  source: VideoRequestAsset | undefined,
  options?: {
    preferLocalFile?: boolean;
  },
): Promise<ProviderAssetInput | undefined> {
  if (!source) return undefined;
  if (typeof source === 'object' && 'transport' in source && 'value' in source) {
    return source as ProviderAssetInput;
  }
  return resolveProviderAssetInput(source as MediaAssetSource, options);
}

async function ensureProviderAssetInputs(
  sources: Array<VideoRequestAsset | undefined>,
  options?: {
    preferLocalFile?: boolean;
  },
): Promise<ProviderAssetInput[]> {
  const resolved = await Promise.all(sources.map(source => ensureProviderAssetInput(source, options)));
  return resolved.filter(Boolean) as ProviderAssetInput[];
}

async function ensureRemoteUrlForSingleSource(params: {
  projectId: string;
  source: MediaAssetSource | ProviderAssetInput | undefined;
  policy: 'best-effort' | 'required';
  fallbackToSourceOnUploadFailure?: boolean;
}) {
  const { ensureRemoteUrlForImageSource } = await import('../mediaRemoteUrlService');
  return ensureRemoteUrlForImageSource(params);
}

async function ensureRemoteUrlForMultipleSources(params: {
  projectId: string;
  sources: Array<MediaAssetSource | ProviderAssetInput | undefined>;
  policy: 'best-effort' | 'required';
  fallbackToSourceOnUploadFailure?: boolean;
}) {
  const { ensureRemoteUrlForImageSources } = await import('../mediaRemoteUrlService');
  return ensureRemoteUrlForImageSources(params);
}

async function ensureRemoteUrlForImageToVideoSources(params: {
  projectId: string;
  primaryImage: VideoRequestAsset | undefined;
  additionalReferences: VideoRequestAsset[];
  primaryPolicy: 'best-effort' | 'required';
  additionalPolicy: 'best-effort' | 'required';
  fallbackToSourceOnUploadFailure?: boolean;
}): Promise<{
  primaryImage: VideoRequestAsset | undefined;
  additionalReferences: Array<VideoRequestAsset | undefined>;
}> {
  if (params.primaryPolicy === 'required' && params.additionalPolicy === 'required') {
    const [primaryImage, ...additionalReferences] = await ensureRemoteUrlForMultipleSources({
      projectId: params.projectId,
      sources: [
        params.primaryImage as MediaAssetSource | ProviderAssetInput | undefined,
        ...(params.additionalReferences as Array<MediaAssetSource | ProviderAssetInput>),
      ],
      policy: 'required',
      fallbackToSourceOnUploadFailure: params.fallbackToSourceOnUploadFailure,
    });
    return {
      primaryImage,
      additionalReferences,
    };
  }

  const [primaryImage, additionalReferences] = await Promise.all([
    params.primaryPolicy === 'required'
      ? ensureRemoteUrlForSingleSource({
          projectId: params.projectId,
          source: params.primaryImage as MediaAssetSource | ProviderAssetInput | undefined,
          policy: 'required',
          fallbackToSourceOnUploadFailure: params.fallbackToSourceOnUploadFailure,
        })
      : Promise.resolve(params.primaryImage),
    params.additionalPolicy === 'required'
      ? ensureRemoteUrlForMultipleSources({
          projectId: params.projectId,
          sources: params.additionalReferences as Array<MediaAssetSource | ProviderAssetInput>,
          policy: 'required',
          fallbackToSourceOnUploadFailure: params.fallbackToSourceOnUploadFailure,
        })
      : Promise.resolve(params.additionalReferences as Array<VideoRequestAsset | undefined>),
  ]);

  return {
    primaryImage,
    additionalReferences,
  };
}

async function ensureRemoteUrlForStartEndSources(params: {
  projectId: string;
  startFrame: VideoRequestAsset | undefined;
  endFrame: VideoRequestAsset | undefined;
  startPolicy: 'best-effort' | 'required';
  endPolicy: 'best-effort' | 'required';
  fallbackToSourceOnUploadFailure?: boolean;
}): Promise<{
  startFrame: VideoRequestAsset | undefined;
  endFrame: VideoRequestAsset | undefined;
}> {
  if (params.startPolicy === 'required' && params.endPolicy === 'required') {
    const [startFrame, endFrame] = await ensureRemoteUrlForMultipleSources({
      projectId: params.projectId,
      sources: [
        params.startFrame as MediaAssetSource | ProviderAssetInput | undefined,
        params.endFrame as MediaAssetSource | ProviderAssetInput | undefined,
      ],
      policy: 'required',
      fallbackToSourceOnUploadFailure: params.fallbackToSourceOnUploadFailure,
    });
    return {
      startFrame,
      endFrame,
    };
  }

  const [startFrame, endFrame] = await Promise.all([
    params.startPolicy === 'required'
      ? ensureRemoteUrlForSingleSource({
          projectId: params.projectId,
          source: params.startFrame as MediaAssetSource | ProviderAssetInput | undefined,
          policy: 'required',
          fallbackToSourceOnUploadFailure: params.fallbackToSourceOnUploadFailure,
        })
      : Promise.resolve(params.startFrame),
    params.endPolicy === 'required'
      ? ensureRemoteUrlForSingleSource({
          projectId: params.projectId,
          source: params.endFrame as MediaAssetSource | ProviderAssetInput | undefined,
          policy: 'required',
          fallbackToSourceOnUploadFailure: params.fallbackToSourceOnUploadFailure,
        })
      : Promise.resolve(params.endFrame),
  ]);

  return {
    startFrame,
    endFrame,
  };
}

function normalizeVideoRequestOptions(
  options?: Record<string, unknown>,
  durationSpec?: VideoDurationSpec,
): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'duration')) {
    return options;
  }
  return {
    ...options,
    duration: durationSpec
      ? clampDurationToSpec(options.duration, durationSpec)
      : coerceVideoDurationOption(options.duration),
  };
}

function createVideoRequest<TAsset extends VideoRequestAsset>(
  capability: VideoGenerationCapability,
  params: {
    prompt: string;
    options?: Record<string, unknown>;
    primaryImage?: TAsset;
    additionalReferences?: TAsset[];
    referenceImages?: TAsset[];
    startFrame?: TAsset;
    endFrame?: TAsset;
    durationSpec?: VideoDurationSpec;
    /** 透传扩展元数据（如 koma-jimeng 协议的 komaJimengAssets），不带也不报错 */
    metadata?: Record<string, unknown>;
  },
): ITVRequest<TAsset> {
  const options = normalizeVideoRequestOptions(params.options, params.durationSpec);
  const metadata = params.metadata;
  if (capability === 'video.text-to-video') {
    return {
      capability,
      prompt: params.prompt,
      options,
      ...(metadata ? { metadata } : {}),
    };
  }

  if (capability === 'video.image-to-video') {
    if (!params.primaryImage) {
      throw new Error('缺少主图输入');
    }
    return {
      capability,
      prompt: params.prompt,
      primaryImage: params.primaryImage,
      additionalReferences: params.additionalReferences || [],
      options,
      ...(metadata ? { metadata } : {}),
    };
  }

  if (capability === 'video.reference-to-video') {
    if (!params.referenceImages?.length) {
      throw new Error('缺少参考图输入');
    }
    return {
      capability,
      prompt: params.prompt,
      referenceImages: params.referenceImages,
      options,
      ...(metadata ? { metadata } : {}),
    };
  }

  if (!params.startFrame || !params.endFrame) {
    throw new Error('缺少首尾帧输入');
  }
  return {
    capability,
    prompt: params.prompt,
    startFrame: params.startFrame,
    endFrame: params.endFrame,
    options,
    ...(metadata ? { metadata } : {}),
  };
}

export function buildVideoCapabilityRequest(params: {
  capability: VideoGenerationCapability;
  prompt: string;
  options?: Record<string, unknown>;
  primaryImage?: VideoRequestAsset;
  additionalReferences?: VideoRequestAsset[];
  referenceImages?: VideoRequestAsset[];
  startFrame?: VideoRequestAsset;
  endFrame?: VideoRequestAsset;
  durationSpec?: VideoDurationSpec;
}): ITVRequest<VideoRequestAsset>;
export function buildVideoCapabilityRequest<TAsset extends VideoRequestAsset>(params: {
  capability: VideoGenerationCapability;
  prompt: string;
  options?: Record<string, unknown>;
  primaryImage?: TAsset;
  additionalReferences?: TAsset[];
  referenceImages?: TAsset[];
  startFrame?: TAsset;
  endFrame?: TAsset;
  durationSpec?: VideoDurationSpec;
}): ITVRequest<TAsset>;
export function buildVideoCapabilityRequest<TAsset extends VideoRequestAsset>(params: {
  capability: VideoGenerationCapability;
  prompt: string;
  options?: Record<string, unknown>;
  primaryImage?: TAsset;
  additionalReferences?: TAsset[];
  referenceImages?: TAsset[];
  startFrame?: TAsset;
  endFrame?: TAsset;
  durationSpec?: VideoDurationSpec;
}): ITVRequest<TAsset> {
  return createVideoRequest(params.capability, params);
}

export function getPromptProtocol(provider: unknown): string | undefined {
  return (provider as ITVProviderLike | undefined)?.config?.promptProtocol as string | undefined;
}

export function resolveITVTransportSupport(provider: unknown): ITVTransportSupport {
  const transports = (provider as ITVProviderLike | undefined)?.assetTransports;
  const primaryTransports = transports?.primaryImage;
  const additionalTransports = transports?.additionalReferences;
  const referenceTransports = transports?.referenceImages;
  const startTransports = transports?.startFrame;
  const endTransports = transports?.endFrame;

  return {
    primary: supportsDataUrl(primaryTransports),
    additional: supportsDataUrl(additionalTransports ?? primaryTransports),
    reference: supportsDataUrl(referenceTransports ?? additionalTransports ?? primaryTransports),
    start: supportsDataUrl(startTransports ?? primaryTransports),
    end: supportsDataUrl(endTransports ?? additionalTransports ?? startTransports ?? primaryTransports),
  };
}

export function resolveVideoProtocolCompilationLimit(params: {
  provider?: unknown;
  protocol?: string;
}): number | undefined {
  const providerConfig = (params.provider as ITVProviderLike | undefined)?.config || {};
  const configured = toPositiveInt((providerConfig as Record<string, unknown>).maxAdditionalReferences);
  if (configured) {
    return configured;
  }
  if ((providerConfig as Record<string, unknown>).provider === 'grok2api-imagine-itv') {
    // Grok video URL-array 协议最多 7 张图；这里返回“额外参考图”上限，
    // reference-to-video 会在映射层再 +1 得到总图数 7。
    return 6;
  }
  if (params.protocol === 'grok-image-index') {
    return 3;
  }
  return undefined;
}

export function compileVideoRequestPromptReferences<TAsset extends VideoRequestAsset>(
  params: {
    request: ITVRequest<TAsset>;
    promptProtocol?: string;
    promptCompilation?: PromptCompilationInput;
  },
): CompileVideoRequestResult<TAsset> {
  const promptReferences = params.promptCompilation?.promptReferences;
  if (!promptReferences?.references?.length) {
    return {
      request: params.request,
      unresolvedMentions: [],
    };
  }

  // 协议 → 占位符策略：
  //   grok-image-index → @Image N / @Video N / @Audio N
  //   koma-jimeng      → @image_file_N / @video_file_N / @audio_file_N
  //   其它 / 不支持视觉参考的能力 → readable-name
  const replacementStrategy: 'image-index' | 'readable-name' | 'koma-jimeng-file' =
    params.promptProtocol === 'grok-image-index' && supportsVisualReferenceCompilation(params.request.capability)
      ? 'image-index'
      : params.promptProtocol === 'koma-jimeng' && supportsVisualReferenceCompilation(params.request.capability)
        ? 'koma-jimeng-file'
        : 'readable-name';

  const compiled = compilePromptReferences({
    prompt: params.request.prompt,
    references: promptReferences.references,
    extraReferences: promptReferences.extraReferences,
    replacementStrategy,
    primaryReferenceId: promptReferences.primaryReferenceId,
    ensurePrimaryReference: Boolean(promptReferences.ensurePrimaryReference),
  });

  // 协议 = koma-jimeng 时把按 kind 拆分的 URL 列表附在 request.metadata 里，
  // 供 Provider 透传到 metadata.image_urls / video_urls / audio_urls，让网关分发到
  // image_file_N / video_file_N / audio_file_N。
  const mergeKomaJimengMetadata = <T>(req: T): T => {
    if (params.promptProtocol !== 'koma-jimeng') return req;
    const existing = (req as unknown as { metadata?: Record<string, unknown> }).metadata ?? {};
    return {
      ...(req as object),
      metadata: {
        ...existing,
        komaJimengAssets: {
          image_urls: compiled.compiledByKind.image,
          video_urls: compiled.compiledByKind.video,
          audio_urls: compiled.compiledByKind.audio,
        },
      },
    } as T;
  };

  if (isImageToVideoRequest(params.request)) {
    return {
      request: mergeKomaJimengMetadata({
        ...params.request,
        prompt: compiled.compiledPrompt,
        additionalReferences: compiled.compiledReferences as TAsset[],
      }),
      unresolvedMentions: compiled.unresolvedMentions,
    };
  }

  if (isReferenceToVideoRequest(params.request)) {
    return {
      request: mergeKomaJimengMetadata({
        ...params.request,
        prompt: compiled.compiledPrompt,
        referenceImages: compiled.compiledReferences as TAsset[],
      }),
      unresolvedMentions: compiled.unresolvedMentions,
    };
  }

  if (isStartEndToVideoRequest(params.request)) {
    return {
      request: mergeKomaJimengMetadata({
        ...params.request,
        prompt: compiled.compiledPrompt,
        endFrame: (compiled.compiledReferences[0] as TAsset | undefined) || params.request.endFrame,
      }),
      unresolvedMentions: compiled.unresolvedMentions,
    };
  }

  return {
    request: mergeKomaJimengMetadata({
      ...params.request,
      prompt: compiled.compiledPrompt,
    }),
    unresolvedMentions: compiled.unresolvedMentions,
  };
}

export function compileWorkflowVideoDomainRequest(params: {
  request: ITVRequest<VideoRequestAsset>;
  promptCompilation?: PromptCompilationInput;
  protocol?: string;
  maxAdditionalReferences?: number;
}): VideoRequestCompileResult {
  const { request, promptCompilation, protocol, maxAdditionalReferences } = params;
  const originalPrompt = request.prompt;
  let compiledRequest = request;
  let compilationDebug: PromptCompilationDebug | undefined;

  if (
    protocol === 'grok-image-index'
    && promptCompilation?.selectedAssets?.length
    && (isImageToVideoRequest(request) || isReferenceToVideoRequest(request))
  ) {
    if (isImageToVideoRequest(request) && request.primaryImage) {
      const selectedAssets = maxAdditionalReferences != null
        ? promptCompilation.selectedAssets.slice(0, maxAdditionalReferences)
        : promptCompilation.selectedAssets;
      const originalAdditional = request.additionalReferences || [];
      const remainingForExtra = maxAdditionalReferences != null
        ? Math.max(0, maxAdditionalReferences - selectedAssets.length)
        : undefined;
      const extraReferences = remainingForExtra != null
        ? originalAdditional.slice(0, remainingForExtra)
        : originalAdditional;

      const compiled = compileGrokITV({
        prompt: originalPrompt,
        primaryImage: request.primaryImage,
        selectedAssets,
        extraReferences,
      });

      const compiledAdditional = maxAdditionalReferences != null
        ? compiled.compiledAdditionalReferences.slice(0, maxAdditionalReferences)
        : compiled.compiledAdditionalReferences;

      compiledRequest = {
        ...request,
        prompt: compiled.compiledPrompt,
        additionalReferences: compiledAdditional,
      };
      compilationDebug = compiled.debug;
    } else if (isReferenceToVideoRequest(request)) {
      const hasPrimaryReference = Boolean(promptCompilation.primaryReferenceSource);
      const selectedAssets = maxAdditionalReferences != null
        ? promptCompilation.selectedAssets.slice(0, hasPrimaryReference ? maxAdditionalReferences : maxAdditionalReferences + 1)
        : promptCompilation.selectedAssets;

      if (hasPrimaryReference) {
        const originalExtraReferences = request.referenceImages.slice(1);
        const remainingForExtra = maxAdditionalReferences != null
          ? Math.max(0, maxAdditionalReferences - selectedAssets.length)
          : undefined;
        const extraReferences = remainingForExtra != null
          ? originalExtraReferences.slice(0, remainingForExtra)
          : originalExtraReferences;

        const compiled = compileGrokITV({
          prompt: originalPrompt,
          primaryImage: promptCompilation.primaryReferenceSource!,
          selectedAssets,
          extraReferences,
        });

        const compiledReferenceImages = [
          promptCompilation.primaryReferenceSource!,
          ...compiled.compiledAdditionalReferences,
        ];

        compiledRequest = {
          ...request,
          prompt: compiled.compiledPrompt,
          referenceImages: compiledReferenceImages,
        };
        compilationDebug = compiled.debug;
      } else {
        const remainingForExtra = maxAdditionalReferences != null
          ? Math.max(0, maxAdditionalReferences + 1 - selectedAssets.length)
          : undefined;
        const extraReferences = remainingForExtra != null
          ? request.referenceImages.slice(0, remainingForExtra)
          : request.referenceImages;

        const compiled = compileGrokTTI({
          prompt: originalPrompt,
          selectedAssets,
          extraReferences,
        });

        const compiledReferenceImages = maxAdditionalReferences != null
          ? compiled.compiledReferences.slice(0, maxAdditionalReferences + 1)
          : compiled.compiledReferences;

        compiledRequest = {
          ...request,
          prompt: compiled.compiledPrompt,
          referenceImages: compiledReferenceImages,
        };
        compilationDebug = compiled.debug;
      }
    }
  }

  if (
    protocol !== 'grok-image-index'
    && promptCompilation?.selectedAssets?.length
  ) {
    const readablePrompt = compileReadableSelectedAssetMentions({
      prompt: compiledRequest.prompt,
      selectedAssets: promptCompilation.selectedAssets,
    });

    if (readablePrompt !== compiledRequest.prompt) {
      compiledRequest = {
        ...compiledRequest,
        prompt: readablePrompt,
      };
    }
  }

  const promptReferenceCompiled = compileVideoRequestPromptReferences({
    request: compiledRequest,
    promptProtocol: protocol,
    promptCompilation,
  });

  return {
    request: promptReferenceCompiled.request,
    compiledPrompt: promptReferenceCompiled.request.prompt,
    unresolvedMentions: promptReferenceCompiled.unresolvedMentions,
    compilationDebug,
  };
}

export async function mapVideoRequestToProviderRequest(params: {
  projectId: string;
  request: ITVRequest<VideoRequestAsset>;
  transportSupport: ITVTransportSupport;
  maxAdditionalReferences?: number;
  messages?: VideoMappingMessageOverrides;
  preferLocalAssetInput?: boolean;
  fallbackToSourceOnRequiredUploadFailure?: boolean;
}): Promise<ITVRequest<ProviderAssetInput>> {
  const { projectId, request, transportSupport, maxAdditionalReferences } = params;
  const fallbackToSourceOnRequiredUploadFailure =
    params.fallbackToSourceOnRequiredUploadFailure ?? false;
  const messages: Required<VideoMappingMessageOverrides> = {
    missingPrimaryImage: params.messages?.missingPrimaryImage || '缺少主图输入',
    missingReferenceImages: params.messages?.missingReferenceImages || '缺少参考图输入',
    missingStartEndFrames: params.messages?.missingStartEndFrames || '缺少首尾帧输入',
    remotePrimary: params.messages?.remotePrimary || DEFAULT_REMOTE_ONLY_ERROR,
    remoteAdditional: params.messages?.remoteAdditional || DEFAULT_REMOTE_ONLY_ERROR,
    remoteReference: params.messages?.remoteReference || DEFAULT_REMOTE_ONLY_ERROR,
    remoteStart: params.messages?.remoteStart || DEFAULT_REMOTE_ONLY_ERROR,
    remoteEnd: params.messages?.remoteEnd || DEFAULT_REMOTE_ONLY_ERROR,
  };

  if (isTextToVideoRequest(request)) {
    return {
      capability: request.capability,
      prompt: request.prompt,
      options: request.options,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }

  if (isImageToVideoRequest(request)) {
    const primaryPolicy = transportSupport.primary ? 'best-effort' : 'required';
    const additionalPolicy = transportSupport.additional ? 'best-effort' : 'required';
    const additionalInput = maxAdditionalReferences != null
      ? (request.additionalReferences || []).slice(0, maxAdditionalReferences)
      : (request.additionalReferences || []);

    const {
      primaryImage: normalizedPrimary,
      additionalReferences: normalizedAdditional,
    } = await ensureRemoteUrlForImageToVideoSources({
      projectId,
      primaryImage: request.primaryImage,
      additionalReferences: additionalInput,
      primaryPolicy,
      additionalPolicy,
      fallbackToSourceOnUploadFailure: fallbackToSourceOnRequiredUploadFailure,
    });

    const primaryImage = await ensureProviderAssetInput(normalizedPrimary, {
      preferLocalFile: params.preferLocalAssetInput,
    });
    if (!primaryImage) throw new Error(messages.missingPrimaryImage);
    const additionalReferences = await ensureProviderAssetInputs(normalizedAdditional, {
      preferLocalFile: params.preferLocalAssetInput,
    });
    if (
      !fallbackToSourceOnRequiredUploadFailure &&
      !transportSupport.primary &&
      primaryImage.transport !== 'remote-url'
    ) {
      throw new Error(messages.remotePrimary);
    }
    if (
      !fallbackToSourceOnRequiredUploadFailure &&
      !transportSupport.additional &&
      additionalReferences.some(item => item.transport !== 'remote-url')
    ) {
      throw new Error(messages.remoteAdditional);
    }

    return createVideoRequest(request.capability, {
      prompt: request.prompt,
      primaryImage,
      additionalReferences,
      options: request.options,
      metadata: request.metadata,
    }) as ITVRequest<ProviderAssetInput>;
  }

  if (isReferenceToVideoRequest(request)) {
    const additionalPolicy = transportSupport.reference ? 'best-effort' : 'required';
    const referenceSources = maxAdditionalReferences != null
      ? request.referenceImages.slice(0, maxAdditionalReferences + 1)
      : request.referenceImages;
    const normalizedReferenceSources = additionalPolicy === 'required'
      ? await ensureRemoteUrlForMultipleSources({
          projectId,
          sources: referenceSources as MediaAssetSource[],
          policy: additionalPolicy,
          fallbackToSourceOnUploadFailure: fallbackToSourceOnRequiredUploadFailure,
        })
      : referenceSources;
    const referenceImages = await ensureProviderAssetInputs(normalizedReferenceSources, {
      preferLocalFile: params.preferLocalAssetInput,
    });
    if (!referenceImages.length) {
      throw new Error(messages.missingReferenceImages);
    }
    if (
      !fallbackToSourceOnRequiredUploadFailure &&
      !transportSupport.reference &&
      referenceImages.some(item => item.transport !== 'remote-url')
    ) {
      throw new Error(messages.remoteReference);
    }

    return createVideoRequest(request.capability, {
      prompt: request.prompt,
      referenceImages,
      options: request.options,
      metadata: request.metadata,
    }) as ITVRequest<ProviderAssetInput>;
  }

  if (isStartEndToVideoRequest(request)) {
    const startPolicy = transportSupport.start ? 'best-effort' : 'required';
    const endPolicy = transportSupport.end ? 'best-effort' : 'required';
    const {
      startFrame: normalizedStartFrame,
      endFrame: normalizedEndFrame,
    } = await ensureRemoteUrlForStartEndSources({
      projectId,
      startFrame: request.startFrame,
      endFrame: request.endFrame,
      startPolicy,
      endPolicy,
      fallbackToSourceOnUploadFailure: fallbackToSourceOnRequiredUploadFailure,
    });
    const startFrame = await ensureProviderAssetInput(normalizedStartFrame, {
      preferLocalFile: params.preferLocalAssetInput,
    });
    const endFrame = await ensureProviderAssetInput(normalizedEndFrame, {
      preferLocalFile: params.preferLocalAssetInput,
    });
    if (!startFrame || !endFrame) {
      throw new Error(messages.missingStartEndFrames);
    }
    if (
      !fallbackToSourceOnRequiredUploadFailure &&
      !transportSupport.start &&
      startFrame.transport !== 'remote-url'
    ) {
      throw new Error(messages.remoteStart);
    }
    if (
      !fallbackToSourceOnRequiredUploadFailure &&
      !transportSupport.end &&
      endFrame.transport !== 'remote-url'
    ) {
      throw new Error(messages.remoteEnd);
    }

    return createVideoRequest(request.capability, {
      prompt: request.prompt,
      startFrame,
      endFrame,
      options: request.options,
      metadata: request.metadata,
    }) as ITVRequest<ProviderAssetInput>;
  }

  return {
    capability: request.capability,
    prompt: request.prompt,
    options: request.options,
    ...(request.metadata ? { metadata: request.metadata } : {}),
  } as ITVRequest<ProviderAssetInput>;
}
