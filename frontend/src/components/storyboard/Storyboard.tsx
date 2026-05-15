import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Button,
  Space,
  Segmented,
  Select,
  Typography,
  Input,
  Modal,
  Form,
  Spin,
  Empty,
  App,
} from 'antd';
import {
  PlusOutlined,
  LoadingOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import type { Shot, ShotImageMode, ShotScriptLine, Character, Scene, Prop, AppSettings, StoredMediaAsset, ProjectStyleSnapshot, ShotMeta } from '../../types';
import { loadEpisodeShots, saveEpisodeShots, loadCharacters, loadScenes, loadProps, loadEpisodeAnalysis, listShots } from '../../store/projectStore';
import { generateShotImage, batchGenerateShotImages } from '../../services/ShotGenerationService';
import { mediaGenerationService } from '../../services/MediaGenerationService';
import { runWithConcurrency } from '../../utils/concurrency';
import { shotRenderWorkflow, batchRenderShots } from '../../workflow/shotRenderWorkflow';
import { runWithTask } from '../../services/taskRunner';
import { submitShotAnalysisTask } from '../../services/analysisTaskClient';
import type { PresetAssets } from '../../services/ShotAnalysisService';
import { generateShotPrompt, batchGenerateShotPrompts } from '../../services/ShotPromptService';
import { findActiveTask } from '../../services/tasksIPC';
import { useActiveTask, useTaskTransitions, useTasks } from '../../hooks';
import { ScriptEditor } from '../../editor';
import type { MentionItem } from '../../editor';
import { useTheme } from '../../theme/runtime';
import { StoryboardStudio } from './StoryboardStudio';
import { ShotListEditor } from './ShotListEditor';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { ShotAssetPresetModal } from './ShotAssetPresetModal';
import { useShotAssetSync } from '../../hooks/useShotAssetSync';
import { createLogger } from '../../store/logger';
import { loadSettings } from '../../store/globalStore';
import {
  collectShotVideoPlan,
  resolveShotVideoCapabilitySupport,
} from '../../workflow/shotVideoPlan';
import { resolveConfiguredChannelModel } from '../../providers/channel/resolver';
import {
  clampDurationToSpec,
  getDurationSpecForModel,
  getDurationSpecForProviderType,
  specToInputBounds,
  type VideoDurationSpec,
} from '../../providers/itv/durationSpec';
import { getModelMaxReferenceImages } from '../../providers/itv/modelCatalog';
import './Storyboard.scss';
import './ShotListEditor.scss';
import { getMediaAssetDisplaySource, scriptLinesFromText, getShotScriptText } from '../../types';
import { findVersionNumberForVideoAsset } from '../../utils/shotVersionSelection';

const logger = createLogger('Storyboard');

const { Text } = Typography;
const { TextArea } = Input;

const SHOT_TYPE_OPTIONS = [
  { label: 'CU', value: 'close-up' },
  { label: 'MED', value: 'medium' },
  { label: 'WIDE', value: 'wide' },
  { label: 'X-WIDE', value: 'extreme-wide' },
];

const CAMERA_OPTIONS = [
  { label: '固定镜头', value: 'static' },
  { label: '水平摇镜', value: 'pan' },
  { label: '跟随镜头', value: 'tracking' },
  { label: '缓慢推镜', value: 'zoom-in' },
  { label: '手持晃动', value: 'handheld' },
];

type EditableShotImageMode = Exclude<ShotImageMode, 'grid'>;

function normalizeShotImageMode(mode?: ShotImageMode): EditableShotImageMode {
  return mode === 'grid' ? 'grid-9' : (mode || 'normal');
}

function isMultiPanelImageMode(mode?: ShotImageMode): boolean {
  return mode === 'grid' || mode === 'grid-9' || mode === 'grid-4' || mode === 'storyboard';
}

function getShotImageCount(shot: Shot): number {
  return shot.media?.images?.length || 0;
}

function getShotVideoCount(shot: Shot): number {
  return shot.media?.videos?.length || 0;
}

// 合并两个分镜（duration 按当前 ITV 渠道 spec 吸附；不再硬编码到 grok 枚举）
function mergeShots(target: Shot, source: Shot, durationSpec: VideoDurationSpec): Shot {
  const mergedMedia = {
    references: [...(target.media?.references || []), ...(source.media?.references || [])],
    images: [...(target.media?.images || []), ...(source.media?.images || [])],
    videos: [...(target.media?.videos || []), ...(source.media?.videos || [])],
    selectedReferenceIndex: target.media?.selectedReferenceIndex ?? 0,
    currentImageIndex: target.media?.currentImageIndex ?? 0,
    currentVideoIndex: target.media?.currentVideoIndex ?? 0,
  };
  return {
    ...target,
    scriptLines: [...(target.scriptLines || []), ...(source.scriptLines || [])],
    imagePrompt: [target.imagePrompt, source.imagePrompt].filter(Boolean).join('\n\n'),
    duration: clampDurationToSpec(target.duration + source.duration, durationSpec),
    characters: [...new Set([...target.characters, ...source.characters])],
    dialogue: [target.dialogue, source.dialogue].filter(Boolean).join('\n'),
    props: [...new Set([...(target.props || []), ...(source.props || [])])],
    media: mergedMedia,
  };
}

// ============ 主组件 ============
interface StoryboardProps {
  projectId: string;
  episodeId?: string;
  episodeName?: string;
  script?: string;
  aspectRatio?: '16:9' | '9:16';
  llmSelection?: string;
  ttiSelection?: string;
  itvSelection?: string;
  ttsSelection?: string;
  /** 项目级 TTS 音色（覆盖 channel.defaultVoice，留空走 channel 默认） */
  ttsVoiceId?: string;
  /** 项目级 TTS 语速倍数（默认 1.2） */
  ttsSpeed?: number;
  settings: AppSettings;
  styleSnapshot?: ProjectStyleSnapshot;
  mentionItems?: MentionItem[];
  onConfirmedShotsToTimeline?: (shots: Shot[]) => void;
}

export const Storyboard: React.FC<StoryboardProps> = ({
  projectId,
  episodeId,
  episodeName,
  script,
  aspectRatio,
  llmSelection,
  ttiSelection,
  itvSelection,
  ttsSelection,
  ttsVoiceId,
  ttsSpeed,
  settings,
  styleSnapshot,
  mentionItems = [],
  onConfirmedShotsToTimeline: _onConfirmedShotsToTimeline,
}) => {
  const { message } = App.useApp();
  const { theme } = useTheme();
  const isDarkTheme = theme.meta.mode === 'dark';
  const [effectiveSettings, setEffectiveSettings] = useState<AppSettings>(settings);
  const [shots, setShots] = useState<Shot[]>([]);
  const shotsRef = useRef<Shot[]>([]);
  const [shotMetas, setShotMetas] = useState<ShotMeta[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [props, setProps] = useState<Prop[]>([]);
  const [loading, setLoading] = useState(true);
  // 本地"提交中"短暂兜底集合：点击到主进程任务真正落库 (~50-100ms IPC roundtrip)
  // 之间，UI 立即显示 loading；任务进 DB 后由下面 useTasks 派生的集合接管。
  // 切走再回来时，DB 派生的集合还在 → UI 自动恢复；本地 Set 丢失也不影响。
  // 批量场景下 (runWithTask 只创一个 episode-level 父任务) 仍主要靠本地 Set 体现 per-shot loading。
  const [submittingShots, setSubmittingShots] = useState<Set<string>>(new Set());
  const [submittingImagePrompts, setSubmittingImagePrompts] = useState<Set<string>>(new Set());
  const [submittingVideoPrompts, setSubmittingVideoPrompts] = useState<Set<string>>(new Set());
  const [submittingRenderShots, setSubmittingRenderShots] = useState<Set<string>>(new Set());

  // 从主进程任务表派生 active 集合（pending/running/processing），切回页面时自动恢复
  const projectActiveTasks = useTasks({
    scope: `project:${projectId}`,
    activeOnly: true,
  });
  // 批量任务的 task 是 episode-level（targetKind='episode'），对应的"本批次哪些分镜在跑"
  // 通过 metadata.shotIds 暴露；切走再回来时，per-shot loading 指示从这里恢复。
  // 第二个 predicate 可基于 metadata 进一步筛（比如 batchKind 区分图片/视频批量）。
  const collectBatchShotIds = useCallback(
    (
      matchType: (taskType: string) => boolean,
      matchMeta?: (meta: Record<string, unknown>) => boolean,
    ): Set<string> => {
      const set = new Set<string>();
      for (const t of projectActiveTasks) {
        if (!matchType(t.type)) continue;
        if (t.targetKind !== 'episode' || t.targetId !== episodeId) continue;
        const meta = (t.payload?.metadata || {}) as Record<string, unknown>;
        if (matchMeta && !matchMeta(meta)) continue;
        const shotIds = meta.shotIds;
        if (!Array.isArray(shotIds)) continue;
        for (const id of shotIds) {
          if (typeof id === 'string' && id) set.add(id);
        }
      }
      return set;
    },
    [projectActiveTasks, episodeId],
  );

  const activeImagePromptShots = useMemo(() => {
    const set = new Set<string>();
    for (const t of projectActiveTasks) {
      if ((t.type === 'prompt-generation:image' || t.type === 'prompt-optimization:image')
          && t.targetKind === 'shot' && t.targetId) {
        set.add(t.targetId);
      }
    }
    // 批量提示词任务在 episode-level，shotIds 装着本批次目标
    for (const id of collectBatchShotIds(
      (type) => type === 'prompt-generation:image' || type === 'prompt-optimization:image',
    )) {
      set.add(id);
    }
    return set;
  }, [projectActiveTasks, collectBatchShotIds]);
  const activeVideoPromptShots = useMemo(() => {
    const set = new Set<string>();
    for (const t of projectActiveTasks) {
      if ((t.type === 'prompt-generation:video' || t.type === 'prompt-optimization:video')
          && t.targetKind === 'shot' && t.targetId) {
        set.add(t.targetId);
      }
    }
    for (const id of collectBatchShotIds(
      (type) => type === 'prompt-generation:video' || type === 'prompt-optimization:video',
    )) {
      set.add(id);
    }
    return set;
  }, [projectActiveTasks, collectBatchShotIds]);
  const activeImageGenShots = useMemo(() => {
    const set = new Set<string>();
    for (const t of projectActiveTasks) {
      if (t.type === 'tti' && t.targetKind === 'shot' && t.targetId) set.add(t.targetId);
    }
    // 批量图片生成 task type='shot-generation'，批量视频共用同一 type，需用 metadata.batchKind 区分
    for (const id of collectBatchShotIds(
      (type) => type === 'shot-generation',
      (meta) => meta.batchKind === 'image',
    )) {
      set.add(id);
    }
    return set;
  }, [projectActiveTasks, collectBatchShotIds]);
  const activeVideoGenShots = useMemo(() => {
    const set = new Set<string>();
    for (const t of projectActiveTasks) {
      if (t.type === 'itv' && t.targetKind === 'shot' && t.targetId) set.add(t.targetId);
    }
    for (const id of collectBatchShotIds(
      (type) => type === 'shot-generation',
      (meta) => meta.batchKind === 'video',
    )) {
      set.add(id);
    }
    return set;
  }, [projectActiveTasks, collectBatchShotIds]);

  // 切走再回来后，本地 batchProgress 状态丢失。用 episode-level 批量任务的 progress
  // 字段做兜底，让用户至少能看到"批量任务还在跑、当前进度多少"。
  const derivedBatchProgress = useMemo(() => {
    const PARENT_TYPES = new Set([
      'shot-generation',
      'prompt-generation:image', 'prompt-generation:video',
      'prompt-optimization:image', 'prompt-optimization:video',
    ]);
    const batchTask = projectActiveTasks.find(
      t => PARENT_TYPES.has(t.type) && t.targetKind === 'episode' && t.targetId === episodeId,
    );
    if (!batchTask) return undefined;
    const meta = (batchTask.payload?.metadata || {}) as { shotCount?: number; lastMessage?: string };
    const total = typeof meta.shotCount === 'number' ? meta.shotCount : 0;
    if (!total) return undefined;
    // runWithTask 把 progress 映射到 [0, 90]；映射回 [0, 100] 后按总数估算 current。
    const restoredPercent = Math.min(100, Math.round((batchTask.progress / 90) * 100));
    const current = Math.max(0, Math.min(total, Math.round((restoredPercent / 100) * total)));
    return {
      current,
      total,
      step: meta.lastMessage,
    } as { current: number; total: number; step?: string };
  }, [projectActiveTasks, episodeId]);

  // 实际给 UI 用的合并集合：DB 派生 + 本地短暂兜底
  const generatingShots = useMemo(
    () => new Set<string>([...submittingShots, ...activeImageGenShots]),
    [submittingShots, activeImageGenShots],
  );
  const generatingImagePrompts = useMemo(
    () => new Set<string>([...submittingImagePrompts, ...activeImagePromptShots]),
    [submittingImagePrompts, activeImagePromptShots],
  );
  const generatingVideoPrompts = useMemo(
    () => new Set<string>([...submittingVideoPrompts, ...activeVideoPromptShots]),
    [submittingVideoPrompts, activeVideoPromptShots],
  );
  const renderingShots = useMemo(
    () => new Set<string>([...submittingRenderShots, ...activeVideoGenShots]),
    [submittingRenderShots, activeVideoGenShots],
  );
  // 单镜头视频生成进度（按 shotId 聚合，避免多镜头并跑时进度被覆盖）
  const [shotVideoProgress, setShotVideoProgress] = useState<Map<string, { progress: number; step: string }>>(new Map());
  // 点击到任务真正落库之间的短暂"提交中"窗口；任务创建后由 activeAnalysisTask 接管
  const [isSubmittingAnalysis, setIsSubmittingAnalysis] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; step?: string } | undefined>();
  const queuedShotsSaveRef = useRef<{ projectId: string; episodeId: string; shots: Shot[] } | null>(null);
  const activeShotsSaveRef = useRef<Promise<void> | null>(null);
  const shotStoreRefreshRef = useRef<Promise<void>>(Promise.resolve());

  // 预选资产弹窗
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [_presetAssets, setPresetAssets] = useState<PresetAssets | null>(null);

  // 编辑弹窗
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingShot, setEditingShot] = useState<Shot | null>(null);
  const [editFormData, setEditFormData] = useState<Partial<Shot>>({});

  // 舞台区激活的分镜
  const [activeShotId, setActiveShotId] = useState<string | null>(null);
  const projectStylePrompt = useMemo(
    () => styleSnapshot?.ttiStylePrefix?.trim() || '',
    [styleSnapshot]
  );

  useEffect(() => {
    setEffectiveSettings(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;

    const syncLatestSettings = async () => {
      try {
        const latest = await loadSettings();
        if (!cancelled) {
          setEffectiveSettings(latest);
        }
      } catch (error) {
        logger.warn('读取最新全局设置失败，继续使用当前快照', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void syncLatestSettings();
    window.addEventListener('focus', syncLatestSettings);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', syncLatestSettings);
    };
  }, []);

  // 实际使用的 mentionItems
  // 允许在编辑器中 @ 引用所有资产（角色/场景/道具）。
  // 注意：@mention 的 ID 与 useShotAssetSync 的解析规则保持一致（支持内部 ID 与 Sora2 ID）。
  const actualMentionItems: MentionItem[] = useMemo(() => {
    if (mentionItems.length > 0) return mentionItems;
    const items: MentionItem[] = [];

    // 角色：收口使用项目内 ID（在提示词层不混入 Provider 私有 ID）
    characters.forEach(char => {
      items.push({
        id: char.id,
        type: 'char' as const,
        name: char.name,
        description: char.prompt,
        previewImage: getMediaAssetDisplaySource(char.media?.costumePhoto),
      });
    });

    // 场景不需要 Sora2 绑定，保持使用自定义 ID
    scenes.forEach(scene => {
      items.push({
        id: scene.id,
        type: 'scene' as const,
        name: scene.name,
        description: scene.prompt,
        previewImage: getMediaAssetDisplaySource(scene.media?.previewImage),
      });
    });

    // 道具：收口使用项目内 ID
    props.forEach(prop => {
      items.push({
        id: prop.id,
        type: 'prop' as const,
        name: prop.name,
        description: prop.prompt,
        previewImage: getMediaAssetDisplaySource(prop.media?.previewImage),
      });
    });

    return items;
  }, [mentionItems, characters, scenes, props]);

  useEffect(() => {
    logger.info('Storyboard mentionItems ready', {
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      mentionItems: actualMentionItems.length,
    });
  }, [characters.length, scenes.length, props.length, actualMentionItems.length]);

  // 当前选中 ITV 模型的能力矩阵；用于告诉 collectShotVideoPlan 能否走参考生视频，
  // 避免没有真主图时被迫降级到图生视频。
  const selectedItvModelCapabilities = useMemo(() => {
    const ctx = resolveConfiguredChannelModel(effectiveSettings, 'itv', itvSelection);
    return ctx?.model.capabilities;
  }, [effectiveSettings, itvSelection]);

  // 当前 ITV 模型的引用图配额上限；bundle builder 按此裁剪，避免 grok2 / seedance
  // 上游 multipart 限额被触发。
  const selectedItvModelMaxRefs = useMemo(() => {
    const ctx = resolveConfiguredChannelModel(effectiveSettings, 'itv', itvSelection);
    return getModelMaxReferenceImages(ctx?.model, ctx?.channelConfig.providerType);
  }, [effectiveSettings, itvSelection]);

  // 当前 ITV 渠道的时长规格：决定分镜编辑控件是 Select（grok 枚举）还是 InputNumber（即梦范围）
  // 优先按 modelId 命中（Koma 内置即梦渠道复用 grok runtime 但模型是 seedance-*）
  const itvDurationSpec = useMemo(() => {
    const ctx = resolveConfiguredChannelModel(effectiveSettings, 'itv', itvSelection);
    return (
      getDurationSpecForModel(ctx?.model.id)
      ?? getDurationSpecForProviderType(ctx?.channelConfig.providerType)
    );
  }, [effectiveSettings, itvSelection]);

  const shotVideoSupportMap = useMemo(() => {
    return new Map(shots.map(shot => {
      const plan = collectShotVideoPlan({
        shot,
        characters,
        scenes,
        props,
        modelCapabilities: selectedItvModelCapabilities,
        modelMaxRefs: selectedItvModelMaxRefs,
      });
      const support = resolveShotVideoCapabilitySupport({
        settings: effectiveSettings,
        selectionKey: itvSelection,
        capability: plan.capability,
        visualInputCount: plan.visualReferenceInputs.length,
      });
      return [shot.id, support] as const;
    }));
  }, [shots, characters, scenes, props, effectiveSettings, itvSelection, selectedItvModelCapabilities]);

  const buildUnsupportedShotVideoMessage = useCallback((targetShots: Shot[]) => {
    const unsupported = targetShots
      .map(shot => ({
        shot,
        support: shotVideoSupportMap.get(shot.id),
        index: shots.findIndex(item => item.id === shot.id) + 1,
      }))
      .filter(item => item.support?.disabledReason);

    if (unsupported.length === 0) {
      return undefined;
    }

    const sample = unsupported
      .slice(0, 3)
      .map(item => `#${item.index} ${item.support?.capabilityLabel}`)
      .join('、');
    const suffix = unsupported.length > 3 ? ' 等分镜' : '';

    return `${unsupported[0].support?.disabledReason}。受影响分镜：${sample}${suffix}`;
  }, [shotVideoSupportMap, shots]);

  // 加载数据
  const loadData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const loadedShots = episodeId ? await loadEpisodeShots(projectId, episodeId) : [];
      const [loadedCharacters, loadedScenes, loadedProps, episodeAnalysis, loadedShotMetas] = await Promise.all([
        loadCharacters(projectId),
        loadScenes(projectId),
        loadProps(projectId),
        episodeId ? loadEpisodeAnalysis(projectId, episodeId) : Promise.resolve(null),
        listShots(projectId),
      ]);

      // 根据剧集分析结果筛选资产
      let filteredCharacters = loadedCharacters;
      let filteredScenes = loadedScenes;
      let filteredProps = loadedProps;

      if (episodeAnalysis) {
        // 构建 refs 集合：从 episodeAnalysis.xxxRefs + shots 中的资产 ID 合并
        const charRefs = new Set(episodeAnalysis.characterRefs || []);
        const sceneRefs = new Set(episodeAnalysis.sceneRefs || []);
        const propRefs = new Set(episodeAnalysis.propRefs || []);

        // 补充：从 shots 中提取所有引用的资产 ID（兜底 refs 为空的情况）
        for (const shot of loadedShots) {
          for (const id of shot.characters || []) { if (id) charRefs.add(id); }
          for (const id of shot.scenes || []) { if (id) sceneRefs.add(id); }
          for (const id of shot.props || []) { if (id) propRefs.add(id); }
        }

        // 仅在有 refs 时过滤，否则保留全部资产
        if (charRefs.size > 0) {
          filteredCharacters = loadedCharacters.filter(c => charRefs.has(c.id));
        }
        if (sceneRefs.size > 0) {
          filteredScenes = loadedScenes.filter(s => sceneRefs.has(s.id));
        }
        if (propRefs.size > 0) {
          filteredProps = loadedProps.filter(p => propRefs.has(p.id));
        }
      }

      // 一刀切：移除旧数据迁移/修复逻辑。分镜资产绑定与提示词 @mention 统一使用项目内 ID。
      // duration 按当前 ITV 渠道 spec 吸附（grok 枚举 / seedance 范围），不再固定 grok
      const normalizedShots = loadedShots.map(shot => ({ ...shot, duration: clampDurationToSpec(shot.duration, itvDurationSpec) }));
      shotsRef.current = normalizedShots;
      setShots(normalizedShots);
      setShotMetas(loadedShotMetas);
      setCharacters(filteredCharacters);
      setScenes(filteredScenes);
      setProps(filteredProps);

    } catch (err) {
      logger.error('加载失败', err);
      message.error('加载分镜数据失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, episodeId, itvDurationSpec]);

  const refreshShotsFromStore = useCallback(async () => {
    if (!projectId || !episodeId) {
      return;
    }
    const [latestShots, latestShotMetas] = await Promise.all([
      loadEpisodeShots(projectId, episodeId),
      listShots(projectId),
    ]);
    const normalizedShots = latestShots.map(shot => ({ ...shot, duration: clampDurationToSpec(shot.duration, itvDurationSpec) }));
    shotsRef.current = normalizedShots;
    setShots(normalizedShots);
    setShotMetas(latestShotMetas);
  }, [projectId, episodeId, itvDurationSpec]);

  const queueRefreshShotsFromStore = useCallback((): Promise<void> => {
    const next = shotStoreRefreshRef.current
      .catch(() => undefined)
      .then(() => refreshShotsFromStore())
      .catch((error: unknown) => {
        logger.warn('刷新分镜存储失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    shotStoreRefreshRef.current = next;
    return next;
  }, [refreshShotsFromStore]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);

  // 当前剧集的 shot-analysis 任务投影 — 切走再回来 loading 自动复原
  const activeAnalysisTask = useActiveTask({
    scope: `project:${projectId}`,
    type: 'shot-analysis',
    targetKind: 'episode',
    targetId: episodeId,
  });
  const isAnalyzing = isSubmittingAnalysis || !!activeAnalysisTask;
  // 任务被 useActiveTask 接管后清掉提交中标志（避免成功路径不归零）
  useEffect(() => {
    if (activeAnalysisTask) setIsSubmittingAnalysis(false);
  }, [activeAnalysisTask?.id]);

  // 监听分析任务终态转换（edge-triggered 副作用）
  useTaskTransitions(
    {
      scope: `project:${projectId}`,
      type: 'shot-analysis',
      targetKind: 'episode',
      targetId: episodeId,
      to: ['completed', 'failed'],
    },
    (event) => {
      const payload = (event.record.payload || {}) as { result?: { shotsCount?: number } };
      if (event.currStatus === 'completed') {
        message.success(`AI 分镜生成完成，共 ${payload.result?.shotsCount || 0} 个分镜`);
        loadData();
      } else if (event.currStatus === 'failed') {
        logger.error('AI 分镜生成失败', event.record.error);
        message.error('AI 分镜生成失败，请检查 LLM 配置后重试');
      }
    }
  );

  // 监听单 shot 提示词 / 媒体任务完成 → 从 DB 重新拉这个剧集的 shots
  // 解决：用户在 await generateShotPrompt 期间切换页面，组件 unmount 后
  // setShots 落空，回到分镜页时本地 shots 仍是旧数据；DB 已被 service.updateShot
  // 写入新 prompt 但 UI 看不到。改成订阅任务终态转换 → 主动重载，确保
  // 切换/不切换、单条/批量、单端/多窗口都一致。
  const PROMPT_OR_MEDIA_SHOT_TYPES = useMemo(() => new Set([
    'prompt-generation:image', 'prompt-generation:video',
    'prompt-optimization:image', 'prompt-optimization:video',
    'tti', 'itv',
  ]), []);
  // 批量任务用 episode-level task（type='shot-generation' / 'prompt-generation:*'），
  // 终态时也要刷新一次本地 shots —— 之前只对 shot-level 任务刷，导致切走再回来期间
  // 批量完成的产物未在重新挂载后通过 transition 路径再校验一次。
  const BATCH_SHOT_PARENT_TYPES = useMemo(() => new Set([
    'shot-generation',
    'prompt-generation:image', 'prompt-generation:video',
    'prompt-optimization:image', 'prompt-optimization:video',
  ]), []);
  useTaskTransitions(
    {
      scope: `project:${projectId}`,
      to: ['completed', 'failed'],
    },
    (event) => {
      const t = event.record;
      if (PROMPT_OR_MEDIA_SHOT_TYPES.has(t.type) && t.targetKind === 'shot' && t.targetId) {
        void refreshShotsFromStore();
        return;
      }
      // episode-level 批量任务终态：本剧集 batch 完成或失败都要刷新 — 期间组件
      // 可能 unmount 过，setShots 进度回调落空，DB 才是真相。
      if (
        BATCH_SHOT_PARENT_TYPES.has(t.type)
        && t.targetKind === 'episode'
        && t.targetId === episodeId
      ) {
        void refreshShotsFromStore();
      }
    }
  );

  const flushQueuedShotSaves = useCallback((): Promise<void> => {
    if (activeShotsSaveRef.current) {
      return activeShotsSaveRef.current;
    }

    const task = (async () => {
      while (queuedShotsSaveRef.current) {
        const snapshot = queuedShotsSaveRef.current;
        queuedShotsSaveRef.current = null;
        await saveEpisodeShots(snapshot.projectId, snapshot.episodeId, snapshot.shots);
        // 注：原本这里有「分镜变更 → 回写 episode.scriptText」逻辑（D 项 / commit 436a85b），
        // 但会带来副作用：清空全部分镜时剧本也被清空、用户回到剧本步看不到原文了。
        // 已移除——剧本（episode.scriptText）和分镜各自独立持久化，互不影响。
        // 这意味着在分镜内编辑/拖动字幕行不会反向同步到剧本步；如需保持一致用户须重新推文化。
      }
    })();

    activeShotsSaveRef.current = task
      .catch((error: unknown) => {
        logger.error('保存分镜失败', error);
        message.error('保存失败');
      })
      .finally(() => {
        activeShotsSaveRef.current = null;
        if (queuedShotsSaveRef.current) {
          void flushQueuedShotSaves();
        }
      });

    return activeShotsSaveRef.current;
  }, [message]);

  // 保存分镜数据
  const saveAllShots = useCallback((updatedShots: Shot[]) => {
    if (!episodeId) {
      message.warning('未选择剧集，无法保存分镜');
      return Promise.resolve();
    }

    const normalizedShots = updatedShots.map(shot => ({
      ...shot,
      duration: clampDurationToSpec(shot.duration, itvDurationSpec),
    }));

    // 先本地更新，避免输入法组合输入被异步持久化回写打断。
    shotsRef.current = normalizedShots;
    setShots(normalizedShots);
    queuedShotsSaveRef.current = {
      projectId,
      episodeId,
      shots: normalizedShots,
    };

    return flushQueuedShotSaves();
  }, [projectId, episodeId, message, flushQueuedShotSaves, itvDurationSpec]);

  // ============ 回调函数 ============

  const handleDeleteShot = useCallback(async (shotId: string) => {
    const updatedShots = shots.filter(s => s.id !== shotId);
    await saveAllShots(updatedShots);
    message.success('分镜已删除');
  }, [shots, saveAllShots]);

  // 批量删除
  const handleBatchDelete = useCallback(async (shotIds: string[]) => {
    const updatedShots = shots.filter(s => !shotIds.includes(s.id));
    await saveAllShots(updatedShots);
    message.success(`已删除 ${shotIds.length} 个分镜`);
  }, [shots, saveAllShots]);

  const handleGenerateShotImage = useCallback(async (shotId: string) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    const shot = shotsRef.current.find(s => s.id === shotId);
    if (!shot) {
      message.error('分镜不存在');
      return;
    }
    if (!shot.imagePrompt?.trim()) {
      message.warning('请先填写图片提示词');
      return;
    }
    setSubmittingShots(prev => new Set(prev).add(shotId));
    try {
      await flushQueuedShotSaves();
      const asset = await generateShotImage(projectId, episodeId, shotId, characters, scenes, ttiSelection, {
        aspectRatio,
        styleSnapshot,
        shotSnapshot: shot,
        shotsSnapshot: shotsRef.current,
      });
      message.success('分镜图片生成完成');
      const updatedShots = shotsRef.current.map(s => {
        if (s.id !== shotId) return s;
        const existing = s.media?.images || [];
        return {
          ...s,
          media: {
            ...(s.media || {}),
            images: [...existing, asset],
            currentImageIndex: existing.length,
          },
        };
      });
      shotsRef.current = updatedShots;
      setShots(updatedShots);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '启动生成失败');
    } finally {
      setSubmittingShots(prev => {
        const next = new Set(prev);
        next.delete(shotId);
        return next;
      });
    }
  }, [projectId, episodeId, characters, scenes, ttiSelection, aspectRatio, styleSnapshot, message, flushQueuedShotSaves]);

  // 渲染视频
  const handleRenderShotVideo = useCallback(async (shotId: string) => {
    const shot = shotsRef.current.find(s => s.id === shotId);
    if (!shot) return;
    if (!shot.videoPrompt?.trim()) {
      message.warning('请先填写视频提示词');
      return;
    }
    const support = shotVideoSupportMap.get(shotId);
    if (support?.disabledReason) {
      message.error(support.disabledReason);
      return;
    }
    setSubmittingRenderShots(prev => new Set(prev).add(shotId));
    setShotVideoProgress(prev => {
      const next = new Map(prev);
      next.set(shotId, { progress: 0, step: '准备渲染...' });
      return next;
    });
    try {
      await flushQueuedShotSaves();
      const { result } = await runWithTask({
        projectId,
        category: 'analysis',
        subType: 'shot-generation',
        targetType: 'shot',
        targetId: shotId,
        targetName: `分镜 #${shotId.slice(-6)} 视频生成`,
        type: 'shot-generation',
        execute: async (taskCtx) => shotRenderWorkflow(
          {
            projectId,
            episodeId,
            shot,
            settings: effectiveSettings,
            aspectRatio,
            mediaSelections: {
              ttiSelection,
              itvSelection,
              ttsSelection,
            },
            styleSnapshot,
            allShots: shotsRef.current,
          },
          (progress, step) => {
            setShotVideoProgress(prev => {
              const next = new Map(prev);
              next.set(shotId, { progress, step: step || '' });
              return next;
            });
            taskCtx.progress(progress, step);
          }
        ),
      });
      if (result.success && result.version) {
        await refreshShotsFromStore();
        message.success('分镜渲染完成');
      } else {
        message.error(result.error || '渲染失败');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '渲染失败');
    } finally {
      setSubmittingRenderShots(prev => {
        const next = new Set(prev);
        next.delete(shotId);
        return next;
      });
      setShotVideoProgress(prev => {
        const next = new Map(prev);
        next.delete(shotId);
        return next;
      });
    }
  }, [projectId, episodeId, shotVideoSupportMap, effectiveSettings, ttiSelection, itvSelection, ttsSelection, aspectRatio, styleSnapshot, message, refreshShotsFromStore, flushQueuedShotSaves]);

  // 单分镜内字幕行变更（编辑 / 添加 / 删除 / 同分镜内排序 / 任意位置插入）
  const handleScriptLinesChange = useCallback((shotId: string, lines: ShotScriptLine[]) => {
    const updatedShots = shots.map(s =>
      s.id === shotId ? { ...s, scriptLines: lines } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  // dnd-kit 传感器：用 PointerSensor + 5px 激活距离，避免误触发
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  /**
   * 字幕行块拖拽落点处理（同分镜 + 跨分镜）。
   * 拖拽源 / 落点 id 编码为 `${shotId}::${lineId}`；解析归属后做相应数组操作：
   * - 同分镜：本镜 scriptLines 内重新排序
   * - 跨分镜：从源镜 scriptLines 删除该行，插入到目标镜对应位置
   */
  const handleScriptLineDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    if (activeKey === overKey) return;
    const [srcShotId, srcLineId] = activeKey.split('::');
    const [dstShotId, dstLineId] = overKey.split('::');
    if (!srcShotId || !srcLineId || !dstShotId || !dstLineId) return;

    if (srcShotId === dstShotId) {
      // 同分镜：移动 srcLineId 到 dstLineId 位置
      const next = shots.map(shot => {
        if (shot.id !== srcShotId) return shot;
        const fromIdx = (shot.scriptLines || []).findIndex(l => l.id === srcLineId);
        const toIdx = (shot.scriptLines || []).findIndex(l => l.id === dstLineId);
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return shot;
        const list = [...(shot.scriptLines || [])];
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
        return { ...shot, scriptLines: list };
      });
      saveAllShots(next);
      return;
    }

    // 跨分镜：从源镜删除，插到目标镜的目标位置
    const src = shots.find(s => s.id === srcShotId);
    const dst = shots.find(s => s.id === dstShotId);
    if (!src || !dst) return;
    const movedLine = (src.scriptLines || []).find(l => l.id === srcLineId);
    if (!movedLine) return;
    const newSrcLines = (src.scriptLines || []).filter(l => l.id !== srcLineId);
    const dstInsertIdx = (dst.scriptLines || []).findIndex(l => l.id === dstLineId);
    const dstLines = [...(dst.scriptLines || [])];
    if (dstInsertIdx < 0) {
      dstLines.push(movedLine);
    } else {
      dstLines.splice(dstInsertIdx, 0, movedLine);
    }
    const next = shots.map(shot => {
      if (shot.id === srcShotId) return { ...shot, scriptLines: newSrcLines };
      if (shot.id === dstShotId) return { ...shot, scriptLines: dstLines };
      return shot;
    });
    saveAllShots(next);
  }, [shots, saveAllShots]);

  // 分镜时长变更
  const handleDurationChange = useCallback((shotId: string, duration: number) => {
    const safeDuration = clampDurationToSpec(duration, itvDurationSpec);
    const updatedShots = shots.map(s =>
      s.id === shotId ? { ...s, duration: safeDuration } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots, itvDurationSpec]);

  // 资产同步 Hook
  const assets = useMemo(() => ({ characters, scenes, props }), [characters, scenes, props]);
  const { syncFromPrompt, handleAssetChange } = useShotAssetSync(assets);

  // 提示词变更时的资产同步策略：
  // 1. 批量生成期间跳过同步（generatingImagePrompts 守卫）
  // 2. 仅当提示词包含 @mentions 时才更新资产绑定（hasMentions 守卫）
  // 3. ScriptEditor 外部 value 同步时不触发 onChange（isSyncingExternalRef）
  const handleImagePromptChange = useCallback((shotId: string, imagePrompt: string) => {
    // 批量生成期间，ScriptEditor 的 value 同步会触发 onChange，
    // 但此时 shots 闭包可能是旧状态，直接跳过避免覆盖批量生成的正确数据
    if (generatingImagePrompts.has(shotId)) return;

    const currentShots = shotsRef.current;
    const shot = currentShots.find(s => s.id === shotId);
    if (!shot) return;

    // 解析提示词中的 @mentions，同步到资产选择
    const syncState = syncFromPrompt(imagePrompt);

    // 仅当提示词中确实包含 @mentions 时才更新资产绑定，避免空解析结果覆盖已有数据
    const hasMentions = syncState.mentionedAssets.length > 0;

    const updatedShots = currentShots.map(s =>
      s.id === shotId ? {
        ...s,
        imagePrompt,
        ...(hasMentions ? {
          characters: syncState.selectedCharacters,
          scenes: syncState.selectedScenes,
          props: syncState.selectedProps,
        } : {}),
      } : s
    );
    saveAllShots(updatedShots);
  }, [saveAllShots, syncFromPrompt, generatingImagePrompts]);

  // 视频提示词变更时的资产同步策略（同 handleImagePromptChange）：
  // 1. 批量生成期间跳过同步（generatingVideoPrompts 守卫）
  // 2. 仅当提示词包含 @mentions 时才更新资产绑定（hasMentions 守卫）
  // 3. ScriptEditor 外部 value 同步时不触发 onChange（isSyncingExternalRef）
  const handleVideoPromptChange = useCallback((shotId: string, videoPrompt: string) => {
    // 批量生成期间跳过，同 handleImagePromptChange
    if (generatingVideoPrompts.has(shotId)) return;

    const currentShots = shotsRef.current;
    const shot = currentShots.find(s => s.id === shotId);
    if (!shot) return;

    // 解析提示词中的 @mentions，同步到资产选择
    const syncState = syncFromPrompt(videoPrompt);

    // 仅当提示词中确实包含 @mentions 时才更新资产绑定，避免空解析结果覆盖已有数据
    const hasMentions = syncState.mentionedAssets.length > 0;

    const updatedShots = currentShots.map(s =>
      s.id === shotId ? {
        ...s,
        videoPrompt,
        ...(hasMentions ? {
          characters: syncState.selectedCharacters,
          scenes: syncState.selectedScenes,
          props: syncState.selectedProps,
        } : {}),
      } : s
    );
    saveAllShots(updatedShots);
  }, [saveAllShots, syncFromPrompt, generatingVideoPrompts]);

  // 角色变更 - 同时更新提示词中的 @mentions
  const handleCharactersChange = useCallback((shotId: string, characterIds: string[]) => {
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    // 更新图像提示词中的角色 mentions
    const newImagePrompt = handleAssetChange('character', characterIds, shot.imagePrompt || '', assets);
    // 更新视频提示词中的角色 mentions
    const newVideoPrompt = handleAssetChange('character', characterIds, shot.videoPrompt || '', assets);

    const updatedShots = shots.map(s =>
      s.id === shotId ? {
        ...s,
        characters: characterIds,
        imagePrompt: newImagePrompt,
        videoPrompt: newVideoPrompt,
      } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots, handleAssetChange, assets]);

  // 场景变更 - 同时更新提示词中的 @mentions
  const handleScenesChange = useCallback((shotId: string, sceneIds: string[]) => {
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    const newImagePrompt = handleAssetChange('scene', sceneIds, shot.imagePrompt || '', assets);
    const newVideoPrompt = handleAssetChange('scene', sceneIds, shot.videoPrompt || '', assets);

    const updatedShots = shots.map(s =>
      s.id === shotId ? {
        ...s,
        scenes: sceneIds,
        imagePrompt: newImagePrompt,
        videoPrompt: newVideoPrompt,
      } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots, handleAssetChange, assets]);

  // 参考图变更
  const handleReferenceImagesChange = useCallback((shotId: string, referenceImages: StoredMediaAsset[], selectedReferenceIndex: number) => {
    const updatedShots = shots.map(s =>
      s.id === shotId ? {
        ...s,
        media: {
          ...(s.media || {}),
          references: referenceImages,
          selectedReferenceIndex,
        },
      } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  // 道具变更 - 同时更新提示词中的 @mentions
  const handlePropsChange = useCallback((shotId: string, propIds: string[]) => {
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    const newImagePrompt = handleAssetChange('prop', propIds, shot.imagePrompt || '', assets);
    const newVideoPrompt = handleAssetChange('prop', propIds, shot.videoPrompt || '', assets);

    const updatedShots = shots.map(s =>
      s.id === shotId ? {
        ...s,
        props: propIds,
        imagePrompt: newImagePrompt,
        videoPrompt: newVideoPrompt,
      } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots, handleAssetChange, assets]);

  // 多图片变更
  const handleImagesChange = useCallback((shotId: string, images: StoredMediaAsset[], currentImageIndex: number) => {
    const updatedShots = shots.map(s =>
      s.id === shotId ? {
        ...s,
        media: {
          ...(s.media || {}),
          images,
          currentImageIndex,
        },
      } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  // 多视频变更
  const handleVideosChange = useCallback((shotId: string, videos: StoredMediaAsset[], currentVideoIndex: number) => {
    const selectedVersion = findVersionNumberForVideoAsset(
      shotMetas.find(meta => meta.id === shotId),
      videos[currentVideoIndex],
    );
    const updatedShots = shots.map(s =>
      s.id === shotId ? {
        ...s,
        currentVersion: selectedVersion ?? s.currentVersion,
        media: {
          ...(s.media || {}),
          videos,
          currentVideoIndex,
        },
      } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots, shotMetas]);

  // 向上合并
  const handleMergeUp = useCallback(async (shotId: string) => {
    const index = shots.findIndex(s => s.id === shotId);
    if (index <= 0) return;
    const target = shots[index - 1];
    const source = shots[index];
    const merged = mergeShots(target, source, itvDurationSpec);
    const updatedShots = shots.filter((_, i) => i !== index).map((s, i) =>
      i === index - 1 ? merged : s
    );
    await saveAllShots(updatedShots);
    message.success('分镜已向上合并');
  }, [shots, saveAllShots, itvDurationSpec]);

  // 向下合并
  const handleMergeDown = useCallback(async (shotId: string) => {
    const index = shots.findIndex(s => s.id === shotId);
    if (index < 0 || index >= shots.length - 1) return;
    const target = shots[index];
    const source = shots[index + 1];
    const merged = mergeShots(target, source, itvDurationSpec);
    const updatedShots = shots.filter((_, i) => i !== index + 1).map((s, i) =>
      i === index ? merged : s
    );
    await saveAllShots(updatedShots);
    message.success('分镜已向下合并');
  }, [shots, saveAllShots, itvDurationSpec]);

  // 上移
  const handleMoveUp = useCallback(async (shotId: string) => {
    const index = shots.findIndex(s => s.id === shotId);
    if (index <= 0) return;
    const updatedShots = [...shots];
    [updatedShots[index - 1], updatedShots[index]] = [updatedShots[index], updatedShots[index - 1]];
    await saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  // 下移
  const handleMoveDown = useCallback(async (shotId: string) => {
    const index = shots.findIndex(s => s.id === shotId);
    if (index < 0 || index >= shots.length - 1) return;
    const updatedShots = [...shots];
    [updatedShots[index], updatedShots[index + 1]] = [updatedShots[index + 1], updatedShots[index]];
    await saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  // 生成图片提示词（首次生成）
  const handleGenerateImagePrompt = useCallback(async (shotId: string) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    const shot = shotsRef.current.find(s => s.id === shotId);
    if (!shot) return;
    setSubmittingImagePrompts(prev => new Set(prev).add(shotId));
    try {
      await flushQueuedShotSaves();
      const shotsSnapshot = shotsRef.current;
      const latestShot = shotsSnapshot.find(s => s.id === shotId) || shot;
      const result = await generateShotPrompt(
        projectId,
        episodeId,
        latestShot,
        projectStylePrompt,
        llmSelection,
        { image: true, video: false },  // 只生成图片提示词
        { shotsSnapshot },
        styleSnapshot
      );
      if (result.success) {
        const updatedShots = shotsRef.current.map(s => s.id === shotId ? {
          ...s,
          imagePrompt: result.imagePrompt,
        } : s);
        shotsRef.current = updatedShots;
        setShots(updatedShots);
        message.success('图片提示词生成完成');
      } else {
        message.error(result.error || '生成失败');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '生成失败');
    } finally {
      setSubmittingImagePrompts(prev => {
        const next = new Set(prev);
        next.delete(shotId);
        return next;
      });
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, flushQueuedShotSaves]);

  // 生成视频提示词（首次生成）
  const handleGenerateVideoPrompt = useCallback(async (shotId: string) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    const shot = shotsRef.current.find(s => s.id === shotId);
    if (!shot) return;
    setSubmittingVideoPrompts(prev => new Set(prev).add(shotId));
    try {
      await flushQueuedShotSaves();
      const shotsSnapshot = shotsRef.current;
      const latestShot = shotsSnapshot.find(s => s.id === shotId) || shot;
      const result = await generateShotPrompt(
        projectId,
        episodeId,
        latestShot,
        projectStylePrompt,
        llmSelection,
        { image: false, video: true },  // 只生成视频提示词
        { shotsSnapshot },
        styleSnapshot
      );
      if (result.success) {
        const updatedShots = shotsRef.current.map(s => s.id === shotId ? {
          ...s,
          videoPrompt: result.videoPrompt,
        } : s);
        shotsRef.current = updatedShots;
        setShots(updatedShots);
        message.success('视频提示词生成完成');
      } else {
        message.error(result.error || '生成失败');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '生成失败');
    } finally {
      setSubmittingVideoPrompts(prev => {
        const next = new Set(prev);
        next.delete(shotId);
        return next;
      });
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, flushQueuedShotSaves]);

  // 优化图片提示词（强制重新生成）
  const handleOptimizeImagePrompt = useCallback(async (shotId: string, _currentPrompt: string) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    const shot = shotsRef.current.find(s => s.id === shotId);
    if (!shot) return;
    setSubmittingImagePrompts(prev => new Set(prev).add(shotId));
    try {
      await flushQueuedShotSaves();
      const shotsSnapshot = shotsRef.current;
      const latestShot = shotsSnapshot.find(s => s.id === shotId) || shot;
      const result = await generateShotPrompt(
        projectId,
        episodeId,
        latestShot,
        projectStylePrompt,
        llmSelection,
        { image: true, video: false },
        { force: true, shotsSnapshot },  // 强制重新生成
        styleSnapshot
      );
      if (result.success) {
        const updatedShots = shotsRef.current.map(s => s.id === shotId ? {
          ...s,
          imagePrompt: result.imagePrompt,
        } : s);
        shotsRef.current = updatedShots;
        setShots(updatedShots);
        message.success('图片提示词优化完成');
      } else {
        message.error(result.error || '优化失败');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '优化失败');
    } finally {
      setSubmittingImagePrompts(prev => {
        const next = new Set(prev);
        next.delete(shotId);
        return next;
      });
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, flushQueuedShotSaves]);

  // 优化视频提示词（强制重新生成）
  const handleOptimizeVideoPrompt = useCallback(async (shotId: string, _currentPrompt: string) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    const shot = shotsRef.current.find(s => s.id === shotId);
    if (!shot) return;
    setSubmittingVideoPrompts(prev => new Set(prev).add(shotId));
    try {
      await flushQueuedShotSaves();
      const shotsSnapshot = shotsRef.current;
      const latestShot = shotsSnapshot.find(s => s.id === shotId) || shot;
      const result = await generateShotPrompt(
        projectId,
        episodeId,
        latestShot,
        projectStylePrompt,
        llmSelection,
        { image: false, video: true },
        { force: true, shotsSnapshot },  // 强制重新生成
        styleSnapshot
      );
      if (result.success) {
        const updatedShots = shotsRef.current.map(s => s.id === shotId ? {
          ...s,
          videoPrompt: result.videoPrompt,
        } : s);
        shotsRef.current = updatedShots;
        setShots(updatedShots);
        message.success('视频提示词优化完成');
      } else {
        message.error(result.error || '优化失败');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '优化失败');
    } finally {
      setSubmittingVideoPrompts(prev => {
        const next = new Set(prev);
        next.delete(shotId);
        return next;
      });
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, flushQueuedShotSaves]);

  // 批量入口前置守门：DB 里已经有同 (type, episode) 的活跃任务（pending/running/processing）
  // 时直接告诉用户当前批量在跑，不再创建第二条。这是离开页面、submitting 本地集合丢失
  // 之后再次点击批量按钮的去重 — 之前只能靠组件内 Set 兜底，unmount 后失效，会重复提交。
  const ensureNoActiveBatch = useCallback(async (
    type: string,
    label: string,
  ): Promise<boolean> => {
    if (!projectId || !episodeId) return true;
    const existing = await findActiveTask({
      scope: `project:${projectId}`,
      type,
      targetKind: 'episode',
      targetId: episodeId,
    });
    if (existing) {
      message.info(`已有${label}任务在执行中，请等待完成（可在任务面板查看进度）`);
      return false;
    }
    return true;
  }, [projectId, episodeId, message]);

  // 批量生成图片提示词（跳过已有图片提示词的）
  const handleBatchGenerateImagePrompts = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    if (!(await ensureNoActiveBatch('prompt-generation:image', '批量图片提示词'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithoutPrompt = baseShots.filter(s => !s.imagePrompt?.trim());
    if (shotsWithoutPrompt.length === 0) {
      message.info('所选分镜都已有图片提示词');
      return;
    }
    const shotIds = shotsWithoutPrompt.map(s => s.id);
    setSubmittingImagePrompts(new Set(shotIds));
    setBatchProgress({ current: 0, total: shotsWithoutPrompt.length, step: '准备生成...' });
    try {
      const results = await batchGenerateShotPrompts(
        projectId,
        episodeId,
        shotsWithoutPrompt,
        projectStylePrompt,
        (current, total, result) => {
          setBatchProgress({ current, total, step: `生成中 ${current}/${total}` });
          if (result.success) {
            setShots(prev => prev.map(s => s.id === result.shotId ? {
              ...s,
              imagePrompt: result.imagePrompt,
            } : s));
          }
        },
        llmSelection,
        styleSnapshot,
        { image: true, video: false },
        { shotsSnapshot: currentShots }
      );
      const successCount = results.filter(r => r.success).length;
      if (successCount === 0 && results.length > 0) {
        const firstError = results.find(r => r.error)?.error;
        message.error(`图片提示词生成全部失败${firstError ? `: ${firstError}` : ''}`);
      } else {
        message.success(`图片提示词生成完成: ${successCount}/${results.length} 成功`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量生成失败');
    } finally {
      setSubmittingImagePrompts(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, ensureNoActiveBatch, message, flushQueuedShotSaves]);

  // 批量重新生成图片提示词
  const handleBatchReGenerateImagePrompts = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    // batchGenerateShotPrompts 的 task type 固定是 prompt-generation:*（不区分 force），
    // 所以 re-generate 与 generate 共享同一去重 key。
    if (!(await ensureNoActiveBatch('prompt-generation:image', '批量图片提示词'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithPrompt = baseShots.filter(s => s.imagePrompt?.trim());
    if (shotsWithPrompt.length === 0) {
      message.info('所选分镜都没有图片提示词');
      return;
    }
    const shotIds = shotsWithPrompt.map(s => s.id);
    setSubmittingImagePrompts(new Set(shotIds));
    setBatchProgress({ current: 0, total: shotsWithPrompt.length, step: '准备重新生成...' });
    try {
      const results = await batchGenerateShotPrompts(
        projectId,
        episodeId,
        shotsWithPrompt,
        projectStylePrompt,
        (current, total, result) => {
          setBatchProgress({ current, total, step: `重新生成中 ${current}/${total}` });
          if (result.success) {
            setShots(prev => prev.map(s => s.id === result.shotId ? {
              ...s,
              imagePrompt: result.imagePrompt,
            } : s));
          }
        },
        llmSelection,
        styleSnapshot,
        { image: true, video: false },
        { force: true, shotsSnapshot: currentShots }
      );
      const successCount = results.filter(r => r.success).length;
      if (successCount === 0 && results.length > 0) {
        const firstError = results.find(r => r.error)?.error;
        message.error(`图片提示词重新生成全部失败${firstError ? `: ${firstError}` : ''}`);
      } else {
        message.success(`图片提示词重新生成完成: ${successCount}/${results.length} 成功`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量重新生成失败');
    } finally {
      setSubmittingImagePrompts(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, ensureNoActiveBatch, message, flushQueuedShotSaves]);

  // 批量生成视频提示词（跳过已有视频提示词的）
  const handleBatchGenerateVideoPrompts = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    if (!(await ensureNoActiveBatch('prompt-generation:video', '批量视频提示词'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithoutPrompt = baseShots.filter(s => !s.videoPrompt?.trim());
    if (shotsWithoutPrompt.length === 0) {
      message.info('所选分镜都已有视频提示词');
      return;
    }
    const shotIds = shotsWithoutPrompt.map(s => s.id);
    setSubmittingVideoPrompts(new Set(shotIds));
    setBatchProgress({ current: 0, total: shotsWithoutPrompt.length, step: '准备生成...' });
    try {
      const results = await batchGenerateShotPrompts(
        projectId,
        episodeId,
        shotsWithoutPrompt,
        projectStylePrompt,
        (current, total, result) => {
          setBatchProgress({ current, total, step: `生成中 ${current}/${total}` });
          if (result.success) {
            setShots(prev => prev.map(s => s.id === result.shotId ? {
              ...s,
              videoPrompt: result.videoPrompt,
            } : s));
          }
        },
        llmSelection,
        styleSnapshot,
        { image: false, video: true },
        { shotsSnapshot: currentShots }
      );
      const successCount = results.filter(r => r.success).length;
      if (successCount === 0 && results.length > 0) {
        const firstError = results.find(r => r.error)?.error;
        message.error(`视频提示词生成全部失败${firstError ? `: ${firstError}` : ''}`);
      } else {
        message.success(`视频提示词生成完成: ${successCount}/${results.length} 成功`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量生成失败');
    } finally {
      setSubmittingVideoPrompts(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, ensureNoActiveBatch, message, flushQueuedShotSaves]);

  // 批量重新生成视频提示词
  const handleBatchReGenerateVideoPrompts = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    if (!(await ensureNoActiveBatch('prompt-generation:video', '批量视频提示词'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithPrompt = baseShots.filter(s => s.videoPrompt?.trim());
    if (shotsWithPrompt.length === 0) {
      message.info('所选分镜都没有视频提示词');
      return;
    }
    const shotIds = shotsWithPrompt.map(s => s.id);
    setSubmittingVideoPrompts(new Set(shotIds));
    setBatchProgress({ current: 0, total: shotsWithPrompt.length, step: '准备重新生成...' });
    try {
      const results = await batchGenerateShotPrompts(
        projectId,
        episodeId,
        shotsWithPrompt,
        projectStylePrompt,
        (current, total, result) => {
          setBatchProgress({ current, total, step: `重新生成中 ${current}/${total}` });
          if (result.success) {
            setShots(prev => prev.map(s => s.id === result.shotId ? {
              ...s,
              videoPrompt: result.videoPrompt,
            } : s));
          }
        },
        llmSelection,
        styleSnapshot,
        { image: false, video: true },
        { force: true, shotsSnapshot: currentShots }
      );
      const successCount = results.filter(r => r.success).length;
      if (successCount === 0 && results.length > 0) {
        const firstError = results.find(r => r.error)?.error;
        message.error(`视频提示词重新生成全部失败${firstError ? `: ${firstError}` : ''}`);
      } else {
        message.success(`视频提示词重新生成完成: ${successCount}/${results.length} 成功`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量重新生成失败');
    } finally {
      setSubmittingVideoPrompts(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, llmSelection, projectStylePrompt, styleSnapshot, ensureNoActiveBatch, message, flushQueuedShotSaves]);

  // 创建新分镜
  const createNewShot = useCallback((): Shot => ({
    id: uuidv4(),
    scriptLines: [],
    shotType: 'medium',
    cameraMovement: 'static',
    duration: 10,
    imagePrompt: '',
    imageMode: 'normal',
    characters: [],
    dialogue: '',
    emotion: '',
  }), []);

  // 在末尾添加分镜
  const handleAddShot = useCallback(async () => {
    const newShot = createNewShot();
    const updatedShots = [...shots, newShot];
    await saveAllShots(updatedShots);
  }, [shots, saveAllShots, createNewShot]);

  const handleShotImageModeChange = useCallback((shotId: string, mode: EditableShotImageMode) => {
    const updatedShots = shots.map(s => {
      if (s.id !== shotId) return s;
      // 模式切换时，图片提示词模板（normal / grid-9 / grid-4 / storyboard）和 TTI 终稿模板都不一样，
      // 视频提示词的 shotsSection 也按模式渲染不同骨架。继续使用旧的 prompt + 旧的 image
      // 会导致 UI 显示前一模式的旧图、新生成走错模板。所以模式切换时必须：
      //  - 清空 images / currentImageIndex（强制让用户重新生成）
      //  - 清空 imagePrompt / videoPrompt（强制重新 AI 推理新模板的提示词）
      // 老 'grid' 视作等同 'grid-9'，imageMode 一旦切到不同变体就触发清空。
      const oldMode = normalizeShotImageMode(s.imageMode);
      const modeChanged = oldMode !== mode;

      // 任一多面板变体（grid / storyboard）+ first-frame 都是非法组合（整张多面板参考 vs
      // 单图微动延展），切到多面板时自动改回 multi-ref。
      const correctedVideoMode = (isMultiPanelImageMode(mode) && s.videoMode === 'first-frame')
        ? 'multi-ref' as const
        : s.videoMode;

      if (!modeChanged) {
        return { ...s, imageMode: mode, videoMode: correctedVideoMode };
      }

      return {
        ...s,
        imageMode: mode,
        videoMode: correctedVideoMode,
        // 清掉前一模式遗留的提示词产物，强制走新模板重推
        imagePrompt: '',
        videoPrompt: '',
        // 清掉前一模式遗留的图片，避免 UI 继续显示老模式的图
        media: {
          ...(s.media || {}),
          images: [],
          currentImageIndex: 0,
          gridImage: undefined,
        },
      };
    });
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  const handleStoryboardInheritPreviousChange = useCallback((shotId: string, enabled: boolean) => {
    const updatedShots = shots.map(s =>
      s.id === shotId ? { ...s, inheritPreviousStoryboard: enabled } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  const handleShotVideoModeChange = useCallback((shotId: string, mode: 'multi-ref' | 'first-frame') => {
    const updatedShots = shots.map(s =>
      s.id === shotId ? { ...s, videoMode: mode } : s
    );
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  /** 批量切换：把当前剧集所有分镜的 videoMode 改为同一值 */
  const handleBulkVideoModeChange = useCallback((mode: 'multi-ref' | 'first-frame') => {
    if (!shots.length) return;
    const updatedShots = shots.map(s => ({ ...s, videoMode: mode }));
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  /**
   * 批量切换：把当前剧集所有分镜的 imageMode 改为同一值（普通 / 四宫格 / 九宫格 / 故事板）。
   *
   * 行为必须与单镜 handleShotImageModeChange 完全一致 —— 模式切换会换模板，旧的
   * imagePrompt / videoPrompt / images 都得清掉重推，否则 UI 还在显示旧模式的图、
   * 新生成又走错模板。同时多面板 + first-frame 是非法组合，要顺手把 videoMode 修回
   * multi-ref。这里逐镜应用单镜的同套规则。
   */
  const handleBulkImageModeChange = useCallback((mode: EditableShotImageMode) => {
    if (!shots.length) return;
    const updatedShots = shots.map(s => {
      const oldMode = normalizeShotImageMode(s.imageMode);
      const modeChanged = oldMode !== mode;

      const correctedVideoMode = (isMultiPanelImageMode(mode) && s.videoMode === 'first-frame')
        ? 'multi-ref' as const
        : s.videoMode;

      if (!modeChanged) {
        return { ...s, imageMode: mode, videoMode: correctedVideoMode };
      }

      return {
        ...s,
        imageMode: mode,
        videoMode: correctedVideoMode,
        imagePrompt: '',
        videoPrompt: '',
        media: {
          ...(s.media || {}),
          images: [],
          currentImageIndex: 0,
          gridImage: undefined,
        },
      };
    });
    saveAllShots(updatedShots);
  }, [shots, saveAllShots]);

  /**
   * 单镜配音：调用 MediaGenerationService.generateAudio
   *
   * 文本来源优先级：shot.dialogue → 否则 join scriptLines（与 prompt 推理同源）。
   * Voice 来源：当前 ttsSelection 渠道的 defaultVoice（在 channel.providerConfig 里），
   * 走 MediaGenerationService 内部 resolveProviderAndContext，不需要这里手动指定。
   */
  const handleGenerateShotAudio = useCallback(async (shotId: string) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    const text = (shot.dialogue || '').trim() || getShotScriptText(shot).trim();
    if (!text) {
      message.warning('该分镜没有可配音的台词或字幕文本');
      return;
    }

    try {
      // 包到 runWithTask：让任务面板能看到这条配音任务（pending → running → completed）。
      // taskName 透到任务记录的 targetName，UI 直接展示中文。
      const { result: asset } = await runWithTask({
        projectId,
        category: 'asset',
        subType: 'audio',
        targetType: 'shot',
        targetId: shotId,
        targetName: `分镜 #${shotId.slice(-6)} 配音`,
        type: 'audio-generation',
        execute: async (taskCtx) => {
          taskCtx.progress(15, '调用 TTS...');
          const a = await mediaGenerationService.generateAudio({
            projectId,
            ownerRef: { projectId, ownerType: 'shot', ownerId: shotId, episodeId, slot: 'audio' },
            // voiceId 来自项目级偏好；空时让 Provider 用 channel 的 defaultVoice（如 cherry）
            // speed 默认 1.2 倍速（业务约定，与 ProjectSettingsModal 默认值对齐）
            request: {
              text,
              voiceId: ttsVoiceId || '',
              options: { rate: typeof ttsSpeed === 'number' ? ttsSpeed : 1.2 },
            },
            ttsSelection,
            taskName: `分镜 #${shotId.slice(-6)} 配音`,
          });
          taskCtx.progress(100, '完成');
          return a;
        },
      });
      message.success('分镜配音生成完成');
      setShots(prev => prev.map(s => {
        if (s.id !== shotId) return s;
        const existing = s.media?.audios || [];
        return {
          ...s,
          media: {
            ...(s.media || {}),
            audios: [...existing, asset],
            currentAudioIndex: existing.length,
          },
        };
      }));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '配音失败');
    }
  }, [projectId, episodeId, shots, ttsSelection, ttsVoiceId, ttsSpeed, message]);

  /**
   * 批量配音：跳过已有配音的分镜（force=false）/ 强制重生成（force=true）。
   * concurrency=2 控制 TTS 并发，避免上游 429。
   */
  const handleBatchAudios = useCallback(async (force: boolean = false, targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    const baseShots = targetShotIds
      ? shots.filter(s => targetShotIds.includes(s.id))
      : shots;
    const candidates = baseShots.filter((s) => {
      const text = (s.dialogue || '').trim() || getShotScriptText(s).trim();
      if (!text) return false;
      const hasAudio = (s.media?.audios?.length || 0) > 0;
      return force ? hasAudio || !hasAudio : !hasAudio;
    });
    if (candidates.length === 0) {
      message.info(force ? '所选分镜都没有可配音的台词' : '所选分镜要么没台词，要么都已有配音');
      return;
    }

    setBatchProgress({ current: 0, total: candidates.length, step: '准备配音...' });

    // 批量任务也包到 runWithTask（target=episode），任务面板能看到一条总进度条。
    // 每个分镜的单条配音也会单独出一条任务（generateAudio 内部走 generateAudio
    // 的轨道，不走 runWithTask；批量这层只统计聚合进度）。
    try {
      const { result: results } = await runWithTask({
        projectId,
        category: 'asset',
        subType: 'audio',
        targetType: 'episode',
        targetId: episodeId,
        targetName: `批量配音（${candidates.length} 个分镜）`,
        type: 'audio-generation',
        metadata: { shotCount: candidates.length, force },
        execute: async (taskCtx) => {
          let done = 0;
          const inner = candidates.map((shot) => async () => {
            const text = (shot.dialogue || '').trim() || getShotScriptText(shot).trim();
            try {
              const asset = await mediaGenerationService.generateAudio({
                projectId,
                ownerRef: { projectId, ownerType: 'shot', ownerId: shot.id, episodeId, slot: 'audio' },
                request: {
                  text,
                  voiceId: ttsVoiceId || '',
                  options: { rate: typeof ttsSpeed === 'number' ? ttsSpeed : 1.2 },
                },
                ttsSelection,
                taskName: `分镜 #${shot.id.slice(-6)} 配音`,
              });
              return { shotId: shot.id, asset, success: true as const };
            } catch (err: unknown) {
              return {
                shotId: shot.id,
                success: false as const,
                error: err instanceof Error ? err.message : String(err),
              };
            } finally {
              done += 1;
              const percent = Math.round((done / candidates.length) * 100);
              setBatchProgress({ current: done, total: candidates.length, step: `分镜 ${shot.id.slice(-6)}` });
              taskCtx.progress(percent, `${done}/${candidates.length} 完成`);
            }
          });
          const settled = await runWithConcurrency(inner, 2);
          return settled.map((r) =>
            r.status === 'fulfilled'
              ? r.value
              : { shotId: '', success: false as const, error: String(r.reason) },
          );
        },
      });
      // 回写 UI shots state（避免依赖 TaskManager 监听）
      setShots(prev => prev.map(s => {
        const hit = results.find(r => r.success && r.shotId === s.id);
        if (!hit?.success || !('asset' in hit)) return s;
        const existing = s.media?.audios || [];
        return {
          ...s,
          media: {
            ...(s.media || {}),
            audios: [...existing, hit.asset],
            currentAudioIndex: existing.length,
          },
        };
      }));
      const successCount = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success);
      if (failed.length === 0) {
        message.success(`批量配音完成：成功 ${successCount}/${results.length}`);
      } else {
        message.warning(`批量配音完成：成功 ${successCount}/${results.length}，失败 ${failed.length}`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量配音失败');
    } finally {
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, shots, ttsSelection, ttsVoiceId, ttsSpeed, message]);

  const handleBatchGenerateAudios = useCallback(
    (targetShotIds?: string[]) => handleBatchAudios(false, targetShotIds),
    [handleBatchAudios],
  );
  const handleBatchReGenerateAudios = useCallback(
    (targetShotIds?: string[]) => handleBatchAudios(true, targetShotIds),
    [handleBatchAudios],
  );

  // 在指定位置上方插入
  const handleInsertAbove = useCallback(async (shotId: string) => {
    const index = shots.findIndex(s => s.id === shotId);
    if (index < 0) return;
    const newShot = createNewShot();
    const updatedShots = [...shots.slice(0, index), newShot, ...shots.slice(index)];
    await saveAllShots(updatedShots);
  }, [shots, saveAllShots, createNewShot]);

  // 在指定位置下方插入
  const handleInsertBelow = useCallback(async (shotId: string) => {
    const index = shots.findIndex(s => s.id === shotId);
    if (index < 0) return;
    const newShot = createNewShot();
    const updatedShots = [...shots.slice(0, index + 1), newShot, ...shots.slice(index + 1)];
    await saveAllShots(updatedShots);
  }, [shots, saveAllShots, createNewShot]);

  // 预选资产确认后执行 AI 分镜生成
  const handlePresetConfirm = useCallback(async (assets: PresetAssets) => {
    setPresetModalOpen(false);
    setPresetAssets(assets);
    setIsSubmittingAnalysis(true);
    try {
      const { deduped } = await submitShotAnalysisTask({
        projectId,
        episodeId: episodeId!,
        episodeName: episodeName || `剧集 ${episodeId}`,
        script: script!,
        llmSelection,
        presetAssets: assets,
        styleSnapshot,
      });
      if (deduped) {
        message.info('当前剧集已在后台生成中，请等待完成后再试。');
      } else {
        message.info('AI 分镜生成任务已启动，可在状态栏查看进度');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '启动生成失败');
      setIsSubmittingAnalysis(false);
    }
  }, [projectId, episodeId, episodeName, script, llmSelection, message, styleSnapshot]);

  const handleGenerateAIShots = useCallback(async () => {
    if (!episodeId || !script) {
      logger.warn('AI 生成被拒：缺少必要参数', {
        hasEpisodeId: !!episodeId,
        hasScript: !!script,
      });
      message.warning('缺少剧集信息或剧本内容');
      return;
    }
    // 检查是否有已绑定 Sora2 的资产，如有则打开预选对话框
    const hasBoundCharacters = characters.some(c => c.sora2CharacterId);
    const hasBoundProps = props.some(p => p.sora2PropId);
    logger.info('点击 AI 智能生成分镜', {
      projectId,
      episodeId,
      episodeName,
      scriptLength: script.length,
      llmSelection,
      charactersCount: characters.length,
      propsCount: props.length,
      hasBoundCharacters,
      hasBoundProps,
      branch: hasBoundCharacters || hasBoundProps ? 'preset-modal' : 'direct',
    });
    if (hasBoundCharacters || hasBoundProps) {
      setPresetModalOpen(true);
    } else {
      // 无已绑定资产，直接生成
      setIsSubmittingAnalysis(true);
      try {
        const { deduped } = await submitShotAnalysisTask({
          projectId,
          episodeId,
          episodeName: episodeName || `剧集 ${episodeId}`,
          script,
          llmSelection,
          styleSnapshot,
        });
        if (deduped) {
          message.info('当前剧集已在后台生成中，请等待完成后再试。');
        } else {
          message.info('AI 分镜生成任务已启动，可在状态栏查看进度');
        }
      } catch (err: any) {
        logger.error('启动 AI 分镜生成失败', err);
        message.error(err.message || '启动生成失败');
        setIsSubmittingAnalysis(false);
      }
    }
  }, [projectId, episodeId, episodeName, script, llmSelection, characters, props, message, styleSnapshot]);

  const handleSaveEdit = useCallback(async () => {
    const editScriptText = getShotScriptText(editFormData as Shot);
    if (!editScriptText.trim()) {
      message.warning('请输入剧本内容');
      return;
    }
    if (!editFormData.imagePrompt?.trim()) {
      message.warning('请输入画面描述');
      return;
    }
    const updatedShot: Shot = {
      ...editingShot!,
      ...editFormData,
      scriptLines: scriptLinesFromText(editScriptText),
      duration: clampDurationToSpec(editFormData.duration ?? editingShot?.duration, itvDurationSpec),
    } as Shot;
    const isNew = !shots.find(s => s.id === editingShot!.id);
    let updatedShots: Shot[];
    if (isNew) {
      updatedShots = [...shots, updatedShot];
      message.success('分镜已添加');
    } else {
      updatedShots = shots.map(s => s.id === updatedShot.id ? updatedShot : s);
      message.success('分镜已更新');
    }
    await saveAllShots(updatedShots);
    setEditModalOpen(false);
    setEditingShot(null);
    setEditFormData({});
  }, [editFormData, editingShot, shots, saveAllShots, itvDurationSpec]);

  // 批量生成图片（跳过已有图片的）
  const handleBatchGenerate = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    // batchGenerateShotImages 与 batchRenderShots 共享 type='shot-generation'，所以
    // 图片批量与视频批量任意一个在跑都要拦下，避免提交链路里 LLM/上游 provider 互相挤压。
    if (!(await ensureNoActiveBatch('shot-generation', '批量图片/视频生成'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithoutImage = baseShots.filter(s => getShotImageCount(s) === 0 && s.imagePrompt?.trim());
    if (shotsWithoutImage.length === 0) {
      message.info('所选分镜都已有图片，或没有可用图片提示词');
      return;
    }
    const shotIds = shotsWithoutImage.map(s => s.id);
    setSubmittingShots(new Set(shotIds));
    try {
      const indexMap = new Map(shotIds.map((id, idx) => [id, idx]));
      setBatchProgress({ current: 0, total: shotIds.length, step: '准备生成...' });
      const results = await batchGenerateShotImages(projectId, episodeId, shotIds, characters, scenes, ttiSelection, {
        aspectRatio,
        styleSnapshot,
        shotsSnapshot: currentShots,
        onItemComplete: async (item) => {
          setSubmittingShots(prev => {
            const next = new Set(prev);
            next.delete(item.shotId);
            return next;
          });
          if (item.success) {
            void queueRefreshShotsFromStore();
          }
        },
        onProgress: (_overall, current) => {
          const idx = (indexMap.get(current.shotId) ?? 0) + 1;
          setBatchProgress({
            current: idx,
            total: shotIds.length,
            step: current.step ? `分镜 ${current.shotId}: ${current.step}` : `分镜 ${current.shotId}`,
          });
        },
      });

      const successCount = results.filter(r => r.success).length;
      if (successCount > 0) {
        await queueRefreshShotsFromStore();
      }
      const failed = results.filter(r => !r.success);
      if (failed.length === 0) {
        message.success(`批量生成完成：成功 ${successCount}/${results.length}`);
      } else {
        message.warning(`批量生成完成：成功 ${successCount}/${results.length}，失败 ${failed.length}`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量生成失败');
    } finally {
      setSubmittingShots(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, characters, scenes, ttiSelection, aspectRatio, styleSnapshot, queueRefreshShotsFromStore, ensureNoActiveBatch, message, flushQueuedShotSaves]);

  // 批量重新生成图片（强制重新生成已有图片的）
  const handleBatchReGenerateImages = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    if (!(await ensureNoActiveBatch('shot-generation', '批量图片/视频生成'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithImage = baseShots.filter(s => getShotImageCount(s) > 0 && s.imagePrompt?.trim());
    if (shotsWithImage.length === 0) {
      message.info('所选分镜都没有图片，或没有可用图片提示词');
      return;
    }
    const shotIds = shotsWithImage.map(s => s.id);
    setSubmittingShots(new Set(shotIds));
    try {
      const indexMap = new Map(shotIds.map((id, idx) => [id, idx]));
      setBatchProgress({ current: 0, total: shotIds.length, step: '准备生成...' });
      const results = await batchGenerateShotImages(projectId, episodeId, shotIds, characters, scenes, ttiSelection, {
        aspectRatio,
        styleSnapshot,
        shotsSnapshot: currentShots,
        onItemComplete: async (item) => {
          setSubmittingShots(prev => {
            const next = new Set(prev);
            next.delete(item.shotId);
            return next;
          });
          if (item.success) {
            void queueRefreshShotsFromStore();
          }
        },
        onProgress: (_overall, current) => {
          const idx = (indexMap.get(current.shotId) ?? 0) + 1;
          setBatchProgress({
            current: idx,
            total: shotIds.length,
            step: current.step ? `分镜 ${current.shotId}: ${current.step}` : `分镜 ${current.shotId}`,
          });
        },
      });

      const successCount = results.filter(r => r.success).length;
      if (successCount > 0) {
        await queueRefreshShotsFromStore();
      }
      const failed = results.filter(r => !r.success);
      if (failed.length === 0) {
        message.success(`批量重新生成完成：成功 ${successCount}/${results.length}`);
      } else {
        message.warning(`批量重新生成完成：成功 ${successCount}/${results.length}，失败 ${failed.length}`);
      }
    } catch (err: any) {
      message.error(err.message || '批量重新生成失败');
    } finally {
      setSubmittingShots(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, characters, scenes, ttiSelection, aspectRatio, styleSnapshot, queueRefreshShotsFromStore, ensureNoActiveBatch, message, flushQueuedShotSaves]);

  // 批量渲染视频（生成空白项：仅渲染没有视频的分镜，与图片批量保持一致）
  const handleBatchRenderVideos = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    if (!(await ensureNoActiveBatch('shot-generation', '批量图片/视频生成'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithoutVideo = baseShots.filter(s => getShotVideoCount(s) === 0 && s.videoPrompt?.trim());
    if (shotsWithoutVideo.length === 0) {
      message.info('所选分镜都已有视频，或没有可用视频提示词');
      return;
    }
    const unsupportedMessage = buildUnsupportedShotVideoMessage(shotsWithoutVideo);
    if (unsupportedMessage) {
      message.error(unsupportedMessage);
      return;
    }
    const shotIds = shotsWithoutVideo.map(s => s.id);
    setSubmittingRenderShots(new Set(shotIds));
    setBatchProgress({ current: 0, total: shotIds.length, step: '准备批量渲染...' });
    try {
      const indexMap = new Map(shotIds.map((id, idx) => [id, idx]));
      const { result } = await runWithTask({
        projectId,
        category: 'analysis',
        subType: 'shot-generation',
        targetType: 'episode',
        targetId: episodeId,
        targetName: `批量视频渲染（${shotsWithoutVideo.length} 个分镜）`,
        type: 'shot-generation',
        metadata: { shotCount: shotsWithoutVideo.length, shotIds, batchKind: 'video' },
        execute: async (taskCtx) => batchRenderShots(
          {
            projectId,
            episodeId,
            shots: shotsWithoutVideo,
            settings: effectiveSettings,
            aspectRatio,
            mediaSelections: {
              ttiSelection,
              itvSelection,
              ttsSelection,
            },
            styleSnapshot,
            allShots: currentShots,
            onShotComplete: async (item) => {
              setSubmittingRenderShots(prev => {
                const next = new Set(prev);
                next.delete(item.shotId);
                return next;
              });
              if (item.success) {
                void queueRefreshShotsFromStore();
              }
            },
          },
          (overall, current) => {
            const idx = (indexMap.get(current.shotId) ?? 0) + 1;
            setBatchProgress({
              current: idx,
              total: shotIds.length,
              step: `分镜 ${current.shotId.slice(-6)}: ${current.step || ''}`,
            });
            taskCtx.progress(overall, `${current.shotId.slice(-6)}: ${current.step || ''}`);
          }
        ),
      });
      await queueRefreshShotsFromStore();
      message.success(`批量渲染完成: ${result.success} 成功, ${result.failed} 失败`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量渲染失败');
    } finally {
      setSubmittingRenderShots(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, effectiveSettings, ttiSelection, itvSelection, ttsSelection, aspectRatio, styleSnapshot, buildUnsupportedShotVideoMessage, message, queueRefreshShotsFromStore, ensureNoActiveBatch, flushQueuedShotSaves]);

  // 批量重新生成视频（已有视频的）
  const handleBatchReGenerateVideos = useCallback(async (targetShotIds?: string[]) => {
    if (!episodeId) {
      message.warning('未选择剧集');
      return;
    }
    if (!(await ensureNoActiveBatch('shot-generation', '批量图片/视频生成'))) return;
    await flushQueuedShotSaves();
    const currentShots = shotsRef.current;
    const baseShots = targetShotIds
      ? currentShots.filter(s => targetShotIds.includes(s.id))
      : currentShots;
    const shotsWithVideo = baseShots.filter(s => getShotVideoCount(s) > 0 && s.videoPrompt?.trim());
    if (shotsWithVideo.length === 0) {
      message.info('所选分镜都没有视频，或没有可用视频提示词');
      return;
    }
    const unsupportedMessage = buildUnsupportedShotVideoMessage(shotsWithVideo);
    if (unsupportedMessage) {
      message.error(unsupportedMessage);
      return;
    }
    const shotIds = shotsWithVideo.map(s => s.id);
    setSubmittingRenderShots(new Set(shotIds));
    setBatchProgress({ current: 0, total: shotIds.length, step: '准备批量重新渲染...' });
    try {
      const indexMap = new Map(shotIds.map((id, idx) => [id, idx]));
      const { result } = await runWithTask({
        projectId,
        category: 'analysis',
        subType: 'shot-generation',
        targetType: 'episode',
        targetId: episodeId,
        targetName: `批量重新渲染视频（${shotsWithVideo.length} 个分镜）`,
        type: 'shot-generation',
        metadata: { shotCount: shotsWithVideo.length, shotIds, batchKind: 'video', regenerate: true },
        execute: async (taskCtx) => batchRenderShots(
          {
            projectId,
            episodeId,
            shots: shotsWithVideo,
            settings: effectiveSettings,
            aspectRatio,
            mediaSelections: {
              ttiSelection,
              itvSelection,
              ttsSelection,
            },
            styleSnapshot,
            allShots: currentShots,
            onShotComplete: async (item) => {
              setSubmittingRenderShots(prev => {
                const next = new Set(prev);
                next.delete(item.shotId);
                return next;
              });
              if (item.success) {
                void queueRefreshShotsFromStore();
              }
            },
          },
          (overall, current) => {
            const idx = (indexMap.get(current.shotId) ?? 0) + 1;
            setBatchProgress({
              current: idx,
              total: shotIds.length,
              step: `分镜 ${current.shotId.slice(-6)}: ${current.step || ''}`,
            });
            taskCtx.progress(overall, `${current.shotId.slice(-6)}: ${current.step || ''}`);
          }
        ),
      });
      await queueRefreshShotsFromStore();
      message.success(`批量重新渲染完成: ${result.success} 成功, ${result.failed} 失败`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      message.error(errorMessage || '批量重新渲染失败');
    } finally {
      setSubmittingRenderShots(new Set());
      setBatchProgress(undefined);
    }
  }, [projectId, episodeId, effectiveSettings, ttiSelection, itvSelection, ttsSelection, aspectRatio, styleSnapshot, buildUnsupportedShotVideoMessage, message, queueRefreshShotsFromStore, ensureNoActiveBatch, flushQueuedShotSaves]);

  // ============ 渲染 ============

  if (loading) {
    return (
      <div className="storyboardContainer storyboardLoading w-500">
        <Spin size="large" description="加载分镜数据...">
        </Spin>
      </div>
    );
  }

  return (
    <div className="storyboardContainer">
      {shots.length === 0 ? (
        <div className="storyboardEmpty">
          <Empty
            description={isAnalyzing ? "AI 正在生成分镜..." : "暂无分镜数据"}
            className="storyboardEmptyContent"
          >
            {isAnalyzing ? (
              <Spin indicator={<LoadingOutlined className="storyboardLoadingIcon" spin />} />
            ) : (
              <Space direction="vertical" size="middle">
                {script && episodeId && (
                  <Button
                    type="primary"
                    size="large"
                    icon={<RobotOutlined />}
                    onClick={handleGenerateAIShots}
                  >
                    AI 智能生成分镜
                  </Button>
                )}
                <Button icon={<PlusOutlined />} onClick={handleAddShot}>
                  手动添加分镜
                </Button>
                {!script && (
                  <Text type="secondary" className="storyboardHint">
                    提示：需要先在剧本步骤输入内容才能使用 AI 生成
                  </Text>
                )}
              </Space>
            )}
          </Empty>
        </div>
      ) : (
        <StoryboardStudio>
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleScriptLineDragEnd}
          >
          <ShotListEditor
            projectId={projectId}
            shots={shots}
            characters={characters}
            scenes={scenes}
            props={props}
            mentionItems={actualMentionItems}
            generatingImagePrompts={generatingImagePrompts}
            generatingVideoPrompts={generatingVideoPrompts}
            generatingImages={generatingShots}
            generatingVideos={renderingShots}
            videoProgressMap={shotVideoProgress}
            batchProgress={batchProgress ?? derivedBatchProgress}
            activeShotId={activeShotId}
            onActiveShotChange={setActiveShotId}
            onScriptLinesChange={handleScriptLinesChange}
            onImagePromptChange={handleImagePromptChange}
            onVideoPromptChange={handleVideoPromptChange}
            onDurationChange={handleDurationChange}
            onCharactersChange={handleCharactersChange}
            onScenesChange={handleScenesChange}
            onPropsChange={handlePropsChange}
            onReferenceImagesChange={handleReferenceImagesChange}
            onImagesChange={handleImagesChange}
            onVideosChange={handleVideosChange}
            onGenerateImagePrompt={handleGenerateImagePrompt}
            onGenerateVideoPrompt={handleGenerateVideoPrompt}
            onOptimizeImagePrompt={handleOptimizeImagePrompt}
            onOptimizeVideoPrompt={handleOptimizeVideoPrompt}
            onBatchGenerateImagePrompts={handleBatchGenerateImagePrompts}
            onBatchReGenerateImagePrompts={handleBatchReGenerateImagePrompts}
            onBatchGenerateVideoPrompts={handleBatchGenerateVideoPrompts}
            onBatchReGenerateVideoPrompts={handleBatchReGenerateVideoPrompts}
            onGenerateImage={handleGenerateShotImage}
            onBatchGenerateImages={handleBatchGenerate}
            onBatchReGenerateImages={handleBatchReGenerateImages}
            onGenerateVideo={handleRenderShotVideo}
            onBatchGenerateVideos={handleBatchRenderVideos}
            onBatchReGenerateVideos={handleBatchReGenerateVideos}
            onGenerateAudio={handleGenerateShotAudio}
            onBatchGenerateAudios={handleBatchGenerateAudios}
            onBatchReGenerateAudios={handleBatchReGenerateAudios}
            getVideoCapabilityLabel={(shotId) => shotVideoSupportMap.get(shotId)?.capabilityLabel}
            getVideoGenerateDisabledReason={(shotId) => shotVideoSupportMap.get(shotId)?.disabledReason}
            onDelete={handleDeleteShot}
            onBatchDelete={handleBatchDelete}
            onMergeUp={handleMergeUp}
            onMergeDown={handleMergeDown}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            onAddShot={handleAddShot}
            onInsertAbove={handleInsertAbove}
            onInsertBelow={handleInsertBelow}
            onShotImageModeChange={handleShotImageModeChange}
            onStoryboardInheritPreviousChange={handleStoryboardInheritPreviousChange}
            onShotVideoModeChange={handleShotVideoModeChange}
            onBulkVideoModeChange={handleBulkVideoModeChange}
            onBulkImageModeChange={handleBulkImageModeChange}
            durationSpec={itvDurationSpec}
          />
          </DndContext>
        </StoryboardStudio>
      )}

      {/* 编辑/添加分镜弹窗 */}
      <Modal
        title={editingShot && shots.find(s => s.id === editingShot.id) ? '编辑分镜' : '添加分镜'}
        open={editModalOpen}
        onCancel={() => { setEditModalOpen(false); setEditingShot(null); setEditFormData({}); }}
        onOk={handleSaveEdit}
        okText="保存"
        cancelText="取消"
        width={700}
      >
        <Form layout="vertical">
          <Form.Item label="剧本内容" required>
            <TextArea
              rows={3}
              placeholder="对应剧本中的内容（每行一句字幕，回车换行）"
              value={getShotScriptText(editFormData as Shot)}
              onChange={(e) => setEditFormData(prev => ({ ...prev, scriptLines: scriptLinesFromText(e.target.value) }))}
            />
          </Form.Item>

          <Form.Item label="画面描述 (Prompt)" required>
            <ScriptEditor
              value={editFormData.imagePrompt || ''}
              onChange={(value) => setEditFormData(prev => ({ ...prev, imagePrompt: value }))}
              placeholder="描述这个镜头的画面，可使用 @ 引用角色或道具"
              mentionItems={actualMentionItems}
              minHeight="120px"
              maxHeight="200px"
              showLineNumbers={false}
              darkTheme={isDarkTheme}
            />
          </Form.Item>

          <Space size="large" className="storyboardEditControls">
            <Form.Item label="景别" className="storyboardCompactFormItem">
              <Segmented
                options={SHOT_TYPE_OPTIONS}
                value={editFormData.shotType || 'medium'}
                onChange={(value) => setEditFormData(prev => ({ ...prev, shotType: value as Shot['shotType'] }))}
              />
            </Form.Item>

            <Form.Item label="运镜" className="storyboardCompactFormItem">
              <Select
                options={CAMERA_OPTIONS}
                value={editFormData.cameraMovement || 'static'}
                onChange={(value) => setEditFormData(prev => ({ ...prev, cameraMovement: value }))}
                className="storyboardCameraSelect"
              />
            </Form.Item>

            <Form.Item label="时长（秒）" className="storyboardCompactFormItem">
              <Input
                type="number"
                min={specToInputBounds(itvDurationSpec).min}
                max={specToInputBounds(itvDurationSpec).max}
                step={specToInputBounds(itvDurationSpec).step}
                value={editFormData.duration ?? itvDurationSpec.default}
                onChange={(e) => setEditFormData(prev => ({
                  ...prev,
                  duration: clampDurationToSpec(e.target.value, itvDurationSpec),
                }))}
                className="storyboardDurationInput"
              />
            </Form.Item>
          </Space>

          <Form.Item label="情绪氛围" className="storyboardEmotionItem">
            <Input
              placeholder="如：紧张、欢快、悲伤..."
              value={editFormData.emotion || ''}
              onChange={(e) => setEditFormData(prev => ({ ...prev, emotion: e.target.value }))}
            />
          </Form.Item>

          <Form.Item label="台词">
            <TextArea
              rows={2}
              placeholder="角色台词（如有）"
              value={editFormData.dialogue || ''}
              onChange={(e) => setEditFormData(prev => ({ ...prev, dialogue: e.target.value }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 预选资产弹窗 */}
      <ShotAssetPresetModal
        open={presetModalOpen}
        characters={characters}
        props={props}
        onConfirm={handlePresetConfirm}
        onCancel={() => setPresetModalOpen(false)}
      />
    </div>
  );
};
