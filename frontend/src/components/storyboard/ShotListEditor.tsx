/**
 * 分镜列表编辑器
 * 内联编辑模式，每行一个分镜
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Button, Typography, Progress } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { StoryboardLayout } from './StoryboardLayout';
import { ShotListHeader } from './ShotListHeader';
import type { MentionItem } from '../../editor';
import type { Shot, ShotImageMode, ShotScriptLine, Character, Scene, Prop, StoredMediaAsset } from '../../types';
import { getMediaAssetDisplaySource } from '../../types';
import { ShotCard } from './ShotCard';

const { Text } = Typography;

export interface ShotListEditorProps {
  projectId: string;
  shots: Shot[];
  characters: Character[];
  scenes: Scene[];
  props: Prop[];
  mentionItems: MentionItem[];
  // 状态拆分：图片/视频提示词独立
  generatingImagePrompts: Set<string>;
  generatingVideoPrompts: Set<string>;
  generatingImages: Set<string>;
  generatingVideos: Set<string>;
  batchProgress?: { current: number; total: number; step?: string };
  activeShotId?: string | null;
  onActiveShotChange?: (shotId: string | null) => void;
  onScriptLinesChange: (shotId: string, lines: ShotScriptLine[]) => void;
  onImagePromptChange: (shotId: string, imagePrompt: string) => void;
  onVideoPromptChange: (shotId: string, videoPrompt: string) => void;
  onDurationChange?: (shotId: string, duration: number) => void;
  onCharactersChange: (shotId: string, characterIds: string[]) => void;
  onScenesChange?: (shotId: string, sceneIds: string[]) => void;
  onPropsChange?: (shotId: string, propIds: string[]) => void;
  onReferenceImagesChange?: (shotId: string, assets: StoredMediaAsset[], selectedIndex: number) => void;
  onImagesChange: (shotId: string, assets: StoredMediaAsset[], selectedIndex: number) => void;
  onVideosChange: (shotId: string, assets: StoredMediaAsset[], selectedIndex: number) => void;
  // 回调拆分：生成 vs 优化，图片 vs 视频
  onGenerateImagePrompt: (shotId: string) => void;
  onGenerateVideoPrompt: (shotId: string) => void;
  onOptimizeImagePrompt: (shotId: string, currentPrompt: string) => void;
  onOptimizeVideoPrompt: (shotId: string, currentPrompt: string) => void;
  onBatchGenerateImagePrompts: (shotIds?: string[]) => void;
  onBatchReGenerateImagePrompts: (shotIds?: string[]) => void;
  onBatchGenerateVideoPrompts: (shotIds?: string[]) => void;
  onBatchReGenerateVideoPrompts: (shotIds?: string[]) => void;
  onGenerateImage: (shotId: string) => void;
  onBatchGenerateImages: (shotIds?: string[]) => void;
  onBatchReGenerateImages: (shotIds?: string[]) => void;
  onGenerateVideo: (shotId: string) => void;
  onBatchGenerateVideos: (shotIds?: string[]) => void;
  onBatchReGenerateVideos: (shotIds?: string[]) => void;
  onGenerateAudio?: (shotId: string) => void;
  onBatchGenerateAudios?: (shotIds?: string[]) => void;
  onBatchReGenerateAudios?: (shotIds?: string[]) => void;
  generatingAudios?: boolean;
  getVideoCapabilityLabel?: (shotId: string) => string | undefined;
  getVideoGenerateDisabledReason?: (shotId: string) => string | undefined;
  onDelete: (shotId: string) => void;
  onBatchDelete: (shotIds: string[]) => void;
  onMergeUp: (shotId: string) => void;
  onMergeDown: (shotId: string) => void;
  onMoveUp: (shotId: string) => void;
  onMoveDown: (shotId: string) => void;
  onAddShot: () => void;
  onInsertAbove: (shotId: string) => void;
  onInsertBelow: (shotId: string) => void;
  onShotImageModeChange: (shotId: string, mode: Exclude<ShotImageMode, 'grid'>) => void;
  onStoryboardInheritPreviousChange?: (shotId: string, enabled: boolean) => void;
  onShotVideoModeChange?: (shotId: string, mode: 'multi-ref' | 'first-frame') => void;
  onBulkVideoModeChange?: (mode: 'multi-ref' | 'first-frame') => void;
  onBulkImageModeChange?: (mode: Exclude<ShotImageMode, 'grid'>) => void;
  /** 当前项目选择的 ITV 渠道时长规格，透传给 ShotCard 决定时长控件渲染方式 */
  durationSpec?: import('../../providers/itv/durationSpec').VideoDurationSpec;
  /** 单镜头视频生成进度（按 shotId 聚合），透传给 ShotCard 渲染百分比与阶段文本 */
  videoProgressMap?: Map<string, { progress: number; step: string }>;
}

export const ShotListEditor: React.FC<ShotListEditorProps> = ({
  projectId,
  shots,
  characters,
  scenes,
  props,
  mentionItems,
  generatingImagePrompts,
  generatingVideoPrompts,
  generatingImages,
  generatingVideos,
  batchProgress,
  activeShotId,
  onActiveShotChange,
  onScriptLinesChange,
  onImagePromptChange,
  onVideoPromptChange,
  onDurationChange,
  onCharactersChange,
  onScenesChange,
  onPropsChange,
  onReferenceImagesChange,
  onImagesChange,
  onVideosChange,
  onGenerateImagePrompt,
  onGenerateVideoPrompt,
  onOptimizeImagePrompt,
  onOptimizeVideoPrompt,
  onBatchGenerateImagePrompts,
  onBatchReGenerateImagePrompts,
  onBatchGenerateVideoPrompts,
  onBatchReGenerateVideoPrompts,
  onGenerateImage,
  onBatchGenerateImages,
  onBatchReGenerateImages,
  onGenerateVideo,
  onBatchGenerateVideos,
  onBatchReGenerateVideos,
  onGenerateAudio,
  onBatchGenerateAudios,
  onBatchReGenerateAudios,
  generatingAudios = false,
  getVideoCapabilityLabel,
  getVideoGenerateDisabledReason,
  onDelete,
  onBatchDelete,
  onMergeUp,
  onMergeDown,
  onMoveUp,
  onMoveDown,
  onAddShot,
  onInsertAbove,
  onInsertBelow,
  onShotImageModeChange,
  onStoryboardInheritPreviousChange,
  onShotVideoModeChange,
  onBulkVideoModeChange,
  onBulkImageModeChange,
  durationSpec,
  videoProgressMap,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const selectedCount = selectedIds.size;
  const hasSelected = selectedCount > 0;
  const isAllSelected = shots.length > 0 && selectedIds.size === shots.length;
  const isIndeterminate = selectedIds.size > 0 && selectedIds.size < shots.length;

  // 全选
  const handleSelectAll = useCallback((checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(shots.map(s => s.id)));
    } else {
      setSelectedIds(new Set());
    }
  }, [shots]);

  // 单选
  const handleSelectChange = useCallback((shotId: string, selected: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (selected) {
        next.add(shotId);
      } else {
        next.delete(shotId);
      }
      return next;
    });
  }, []);

  // 批量操作
  const handleBatchPrompts = useCallback(() => {
    onBatchGenerateImagePrompts(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchGenerateImagePrompts]);

  const handleBatchRePrompts = useCallback(() => {
    onBatchReGenerateImagePrompts(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchReGenerateImagePrompts]);

  const handleBatchImages = useCallback(() => {
    onBatchGenerateImages(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchGenerateImages]);

  const handleBatchReImages = useCallback(() => {
    onBatchReGenerateImages(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchReGenerateImages]);

  const handleBatchVideos = useCallback(() => {
    onBatchGenerateVideos(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchGenerateVideos]);

  const handleBatchReVideos = useCallback(() => {
    onBatchReGenerateVideos(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchReGenerateVideos]);

  const handleBatchAudios = useCallback(() => {
    onBatchGenerateAudios?.(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchGenerateAudios]);

  const handleBatchReAudios = useCallback(() => {
    onBatchReGenerateAudios?.(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchReGenerateAudios]);

  const handleBatchVideoPrompts = useCallback(() => {
    onBatchGenerateVideoPrompts(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchGenerateVideoPrompts]);

  const handleBatchReVideoPrompts = useCallback(() => {
    onBatchReGenerateVideoPrompts(hasSelected ? Array.from(selectedIds) : undefined);
  }, [hasSelected, selectedIds, onBatchReGenerateVideoPrompts]);

  const handleBatchDelete = useCallback(() => {
    if (hasSelected) {
      onBatchDelete(Array.from(selectedIds));
      setSelectedIds(new Set());
    }
  }, [hasSelected, selectedIds, onBatchDelete]);

  // 当外部切换 activeShotId 时，把对应行滚动到可视区域内
  // 用 ref 缓存 shots 列表，避免把 shots 放进依赖数组——shots 的任何字段变化（如剧本字幕行编辑）
  // 都会触发 effect 重跑，结果是用户每次输入都把视图自动滚动一次，体验非常不可控
  const shotsForScrollRef = useRef(shots);
  shotsForScrollRef.current = shots;
  useEffect(() => {
    if (!activeShotId) return;
    const idx = shotsForScrollRef.current.findIndex((s) => s.id === activeShotId);
    if (idx < 0) return;
    virtuosoRef.current?.scrollIntoView({
      index: idx,
      align: 'center',
      behavior: 'smooth',
    });
  }, [activeShotId]);

  const renderShotRow = useCallback(
    (index: number, shot: Shot) => {
      const latestShots = shotsForScrollRef.current;
      const previousStoryboardMention = buildPreviousStoryboardMention(latestShots, index);
      return (
        <ShotCard
          projectId={projectId}
          shot={shot}
          index={index}
          totalCount={latestShots.length}
          characters={characters}
          scenes={scenes}
          props={props}
          mentionItems={mentionItems}
          previousStoryboardMention={previousStoryboardMention}
          isSelected={selectedIds.has(shot.id)}
          isActive={activeShotId === shot.id}
          isGeneratingImagePrompt={generatingImagePrompts.has(shot.id)}
          isGeneratingVideoPrompt={generatingVideoPrompts.has(shot.id)}
          isGeneratingImage={generatingImages.has(shot.id)}
          isGeneratingVideo={generatingVideos.has(shot.id)}
          onSelectChange={handleSelectChange}
          onActivate={onActiveShotChange}
          onScriptLinesChange={onScriptLinesChange}
          onImagePromptChange={onImagePromptChange}
          onVideoPromptChange={onVideoPromptChange}
          onDurationChange={onDurationChange}
          onImageModeChange={onShotImageModeChange}
          onStoryboardInheritPreviousChange={onStoryboardInheritPreviousChange}
          onVideoModeChange={onShotVideoModeChange}
          onCharactersChange={onCharactersChange}
          onScenesChange={onScenesChange}
          onPropsChange={onPropsChange}
          onReferenceImagesChange={onReferenceImagesChange}
          onImagesChange={onImagesChange}
          onVideosChange={onVideosChange}
          onGenerateImagePrompt={onGenerateImagePrompt}
          onGenerateVideoPrompt={onGenerateVideoPrompt}
          onOptimizeImagePrompt={onOptimizeImagePrompt}
          onOptimizeVideoPrompt={onOptimizeVideoPrompt}
          onGenerateImage={onGenerateImage}
          onGenerateVideo={onGenerateVideo}
          onGenerateAudio={onGenerateAudio}
          videoCapabilityLabel={getVideoCapabilityLabel?.(shot.id)}
          videoGenerateDisabledReason={getVideoGenerateDisabledReason?.(shot.id)}
          onDelete={onDelete}
          onMergeUp={onMergeUp}
          onMergeDown={onMergeDown}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onInsertAbove={onInsertAbove}
          onInsertBelow={onInsertBelow}
          durationSpec={durationSpec}
          videoProgress={videoProgressMap?.get(shot.id)}
        />
      );
    },
    [
      projectId,
      characters,
      scenes,
      props,
      mentionItems,
      selectedIds,
      activeShotId,
      generatingImagePrompts,
      generatingVideoPrompts,
      generatingImages,
      generatingVideos,
      handleSelectChange,
      onActiveShotChange,
      onScriptLinesChange,
      onImagePromptChange,
      onVideoPromptChange,
      onDurationChange,
      onShotImageModeChange,
      onStoryboardInheritPreviousChange,
      onShotVideoModeChange,
      onCharactersChange,
      onScenesChange,
      onPropsChange,
      onReferenceImagesChange,
      onImagesChange,
      onVideosChange,
      onGenerateImagePrompt,
      onGenerateVideoPrompt,
      onOptimizeImagePrompt,
      onOptimizeVideoPrompt,
      onGenerateImage,
      onGenerateVideo,
      onGenerateAudio,
      getVideoCapabilityLabel,
      getVideoGenerateDisabledReason,
      onDelete,
      onMergeUp,
      onMergeDown,
      onMoveUp,
      onMoveDown,
      onInsertAbove,
      onInsertBelow,
      durationSpec,
      videoProgressMap,
    ],
  );

  return (
    <StoryboardLayout>
      <div className="flex flex-col h-full">
        {/* 批量进度 */}
        {batchProgress && batchProgress.total > 0 && (
          <div className="px-3 py-1.5 bg-bg-surface border-b border-border-subtle">
            <Progress
              percent={Math.round((batchProgress.current / batchProgress.total) * 100)}
              size="small"
              status="active"
              strokeColor="var(--token-accent-base)"
              trailColor="var(--token-border-subtle)"
            />
            <Text type="secondary" className="batchProgressStep">
              {batchProgress.step || `${batchProgress.current}/${batchProgress.total}`}
            </Text>
          </div>
        )}

        {/* 分镜列表 */}
        {shots.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <Text type="secondary">暂无分镜数据</Text>
            <Button type="primary" icon={<PlusOutlined />} onClick={onAddShot} className="emptyAddButton">
              添加分镜
            </Button>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            {/* 公共表头 - 集成全选和批量操作；置于虚拟滚动外，长列表滚动时常驻可见 */}
            <ShotListHeader
              totalCount={shots.length}
              selectedCount={selectedCount}
              isAllSelected={isAllSelected}
              isIndeterminate={isIndeterminate}
              generatingImagePrompts={generatingImagePrompts.size > 0}
              generatingVideoPrompts={generatingVideoPrompts.size > 0}
              generatingImages={generatingImages.size > 0}
              generatingVideos={generatingVideos.size > 0}
              generatingAudios={generatingAudios}
              onSelectAll={handleSelectAll}
              onBatchPrompts={handleBatchPrompts}
              onBatchRePrompts={handleBatchRePrompts}
              onBatchImages={handleBatchImages}
              onBatchReImages={handleBatchReImages}
              onBatchVideos={handleBatchVideos}
              onBatchReVideos={handleBatchReVideos}
              onBatchVideoPrompts={handleBatchVideoPrompts}
              onBatchReVideoPrompts={handleBatchReVideoPrompts}
              onBatchAudios={onBatchGenerateAudios ? handleBatchAudios : undefined}
              onBatchReAudios={onBatchReGenerateAudios ? handleBatchReAudios : undefined}
              onBulkVideoModeChange={onBulkVideoModeChange}
              onBulkImageModeChange={onBulkImageModeChange}
              onAddShot={onAddShot}
              onBatchDelete={handleBatchDelete}
            />
            {/* 虚拟滚动：行固定 480px 高度。激进预渲染策略让"快速拖滚动条"不再白屏。
                经验数：每个 ShotCard 含 2 个 CodeMirror + 多 grid，单镜挂载成本约 30-50ms；
                想要平滑滚动，必须让"目标位置已挂载"——把缓冲区提到目标视区前后各 ~6 行。
                - increaseViewportBy: 上下各预渲染 2880px（= 6 行 × 480px）
                - overscan: 在 increaseViewportBy 之外再多挂 1440px (= 3 行) 做"已渲染但短暂离屏"
                  缓冲——快速滚动时 Virtuoso 不会立即卸载它们，避免来回滚动反复 mount/unmount
                - defaultItemHeight: 480 与 ShotCard 的 h-[480px] 对齐，省去动态测量
                - initialItemCount: 首屏立即渲染 6 行，避免空白闪烁 */}
            <Virtuoso
              ref={virtuosoRef}
              data={shots}
              computeItemKey={(_, shot) => shot.id}
              itemContent={renderShotRow}
              increaseViewportBy={{ top: 2880, bottom: 2880 }}
              overscan={{ main: 1440, reverse: 1440 }}
              defaultItemHeight={480}
              initialItemCount={Math.min(6, shots.length)}
              className="virtuosoScroller"
            />
          </div>
        )}
      </div>
    </StoryboardLayout>
  );
};

function buildPreviousStoryboardMention(shots: Shot[], currentIndex: number): MentionItem | undefined {
  const current = shots[currentIndex];
  if (current?.imageMode !== 'storyboard') return undefined;
  if (current.inheritPreviousStoryboard === false) return undefined;

  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    const candidate = shots[i];
    const images = candidate.media?.images || [];
    if (!images.length) continue;
    const rawIndex = candidate.media?.currentImageIndex;
    const selectedIndex = Number.isInteger(rawIndex)
      ? Math.min(Math.max(rawIndex as number, 0), images.length - 1)
      : 0;
    const selectedImage = images[selectedIndex] || images[0];
    const previewImage = getMediaAssetDisplaySource(selectedImage);
    if (!previewImage) continue;
    return {
      id: 'anchor',
      type: 'previous_storyboard',
      name: '上一故事板',
      description: `来自分镜 #${i + 1} 的当前选中图片版本 v${selectedIndex + 1}，用于保持剧情、人物、场景和光影连续。`,
      previewImage,
    };
  }
  return undefined;
}

export default ShotListEditor;
