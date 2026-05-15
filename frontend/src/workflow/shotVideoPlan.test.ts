import { describe, expect, it } from 'vitest';
import type {
  AppSettings,
  Character,
  Prop,
  Scene,
  Shot,
  StoredMediaAsset,
} from '../types';
import {
  buildShotVideoRequest,
  collectShotVideoPlan,
  resolveShotVideoCapabilitySupport,
} from './shotVideoPlan';

function createImageAsset(remoteUrl: string): StoredMediaAsset {
  return {
    kind: 'image',
    remoteUrl,
    createdAt: 1,
  };
}

function createShot(partial?: Partial<Shot>): Shot {
  return {
    id: 'shot-1',
    scriptLines: [{ id: 'l1', text: '镜头描述' }],
    shotType: 'medium',
    cameraMovement: 'static',
    duration: 4,
    imagePrompt: '',
    videoPrompt: '',
    characters: [],
    scenes: [],
    props: [],
    media: {},
    ...partial,
  };
}

// 测试 fixture 必须使用 *已注册的* providerType（resolveConfiguredChannelModel 会
// 通过 getBuiltInChannelDefinition 在 ProviderRegistry 里查找 providerType；
// 老的 'runway' / 'vidu' / 'kling' 在 channel 收敛后已下线，会让 resolver 返回 undefined）。
// 这里用现役的 'koma-suihe-itv'（即梦，仅图生视频）+ 'grok2api-imagine-itv'（Grok，全能力）
// 模拟"图生视频专用渠道"和"参考生视频可用渠道"两个真实组合。
function createSettings(): AppSettings {
  return {
    channelConfigs: [
      {
        id: 'koma-suihe-main',
        name: 'Koma 即梦（图生视频）',
        category: 'itv',
        providerType: 'koma-suihe-itv',
        providerConfig: { apiKey: 'suihe-key', baseUrl: 'https://komaapi.com' },
        defaultModelId: 'seedance-i2v-only',
        models: [
          {
            id: 'seedance-i2v-only',
            label: 'Seedance Image-to-Video Only',
            providerModelName: 'seedance-2.0-r',
            // 故意只声明 image-to-video，模拟"不支持文生 / 不支持参考生"的渠道
            capabilities: ['video.image-to-video'],
          },
        ],
        enabled: true,
        source: 'builtin',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'grok-main',
        name: 'Koma 官方 Grok',
        category: 'itv',
        providerType: 'grok2api-imagine-itv',
        providerConfig: { apiKey: 'grok-key', baseUrl: 'https://komaapi.com' },
        defaultModelId: 'grok-imagine-video',
        models: [
          {
            id: 'grok-imagine-video',
            label: 'grok-imagine-video',
            providerModelName: 'grok-imagine-video',
            capabilities: [
              'video.text-to-video',
              'video.image-to-video',
              'video.reference-to-video',
              'video.start-end-to-video',
            ],
          },
        ],
        enabled: true,
        source: 'builtin',
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    mediaDefaults: {
      itv: {
        channelId: 'koma-suihe-main',
        modelId: 'seedance-i2v-only',
      },
    },
    promptTemplates: {},
  };
}

function createReferenceOnlySettings(): AppSettings {
  return {
    channelConfigs: [
      {
        id: 'ref-main',
        name: 'ReferenceOnly',
        category: 'itv',
        providerType: 'custom',
        providerConfig: { apiKey: 'ref-key', baseUrl: 'https://ref.example.com' },
        defaultModelId: 'ref-model-a',
        models: [
          {
            id: 'ref-model-a',
            label: 'ref-a',
            providerModelName: 'ref-a',
            capabilities: ['video.reference-to-video'],
          },
        ],
        enabled: true,
        source: 'builtin',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    mediaDefaults: {
      itv: {
        channelId: 'ref-main',
        modelId: 'ref-model-a',
      },
    },
    promptTemplates: {},
  };
}

describe('shotVideoPlan', () => {
  it('有选中主图且未传模型能力时按图生视频执行，资产留在 bundle 中但不直接进 additional', () => {
    const character: Character = {
      id: 'char-1',
      name: '角色A',
      role: 'protagonist',
      prompt: 'hero',
      media: {
        costumePhoto: createImageAsset('https://cdn.example.com/char.png'),
      },
    };
    const shot = createShot({
      characters: ['char-1'],
      media: {
        images: [createImageAsset('https://cdn.example.com/shot.png')],
        currentImageIndex: 0,
        references: [
          createImageAsset('https://cdn.example.com/manual-ref.png'),
          createImageAsset('https://cdn.example.com/manual-ref.png'),
        ],
      },
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [character],
      scenes: [],
      props: [],
    });

    expect(plan.capability).toBe('video.image-to-video');
    expect(plan.selectedImageSource).toBe('https://cdn.example.com/shot.png');
    expect(plan.additionalReferenceImages).toEqual([
      createImageAsset('https://cdn.example.com/manual-ref.png'),
    ]);
    expect(plan.bundle.items.map(item => item.kind)).toEqual([
      'shot-anchor',
      'character',
      'user-upload',
    ]);

    expect(buildShotVideoRequest({
      plan,
      prompt: '生成一个角色展示镜头',
      duration: 4,
      aspectRatio: '16:9',
    })).toMatchObject({
      capability: 'video.image-to-video',
      prompt: '生成一个角色展示镜头',
      primaryImage: shot.media?.images?.[0],
    });
  });

  it('没有分镜主图时，选中的参考图会作为图生视频主图', () => {
    const referenceAsset = createImageAsset('https://cdn.example.com/manual-ref.png');
    const shot = createShot({
      media: {
        references: [referenceAsset],
        selectedReferenceIndex: 0,
      },
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [],
      scenes: [],
      props: [],
    });

    expect(plan.capability).toBe('video.image-to-video');
    expect(plan.primaryImageInput).toBe(referenceAsset);
    expect(plan.primaryImageSource).toBe('https://cdn.example.com/manual-ref.png');
    expect(buildShotVideoRequest({
      plan,
      prompt: '让静帧角色轻微呼吸并看向镜头',
      duration: 4,
      aspectRatio: '16:9',
    })).toEqual({
      capability: 'video.image-to-video',
      prompt: '让静帧角色轻微呼吸并看向镜头',
      primaryImage: referenceAsset,
      additionalReferences: [],
      options: {
        duration: 4,
        motionPrompt: undefined,
        aspectRatio: '16:9',
      },
    });
  });

  it('未传模型能力时，只有道具资产不会把视频强制改成多参考请求', () => {
    const prop: Prop = {
      id: 'prop-1',
      name: '道具A',
      prompt: 'sword',
      media: {
        previewImage: createImageAsset('https://cdn.example.com/prop.png'),
      },
    };
    const shot = createShot({
      props: ['prop-1'],
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [],
      scenes: [],
      props: [prop],
    });

    expect(plan.capability).toBe('video.text-to-video');
    expect(plan.additionalReferenceImages).toEqual([]);
    expect(plan.bundle.items.map(item => item.kind)).toEqual(['prop']);
    expect(plan.bundle.items[0].mentionToken).toBe('@prop_prop-1');
    expect(buildShotVideoRequest({
      plan,
      prompt: '展示道具细节',
      duration: 4,
      aspectRatio: '1:1',
    })).toEqual({
      capability: 'video.text-to-video',
      prompt: '展示道具细节',
      options: {
        duration: 4,
        motionPrompt: undefined,
        aspectRatio: '1:1',
      },
    });
  });

  it('没有任何视觉输入时走文生视频', () => {
    const plan = collectShotVideoPlan({
      shot: createShot(),
      characters: [],
      scenes: [],
      props: [],
    });

    expect(plan.capability).toBe('video.text-to-video');
  });

  it('阶段 2：多参考模式 + 已生成图 + 模型支持参考生视频 → 走参考生视频，锚点+资产都进 references', () => {
    const character: Character = {
      id: 'char-1',
      name: '角色A',
      role: 'protagonist',
      prompt: 'hero',
      media: { costumePhoto: createImageAsset('https://cdn.example.com/char.png') },
    };
    const scene: Scene = {
      id: 'scene-1',
      name: '场景A',
      prompt: 'dorm',
      media: { previewImage: createImageAsset('https://cdn.example.com/scene.png') },
    } as unknown as Scene;
    const shot = createShot({
      videoMode: 'multi-ref',
      characters: ['char-1'],
      scenes: ['scene-1'],
      media: {
        images: [createImageAsset('https://cdn.example.com/anchor.png')],
        currentImageIndex: 0,
      },
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [character],
      scenes: [scene],
      props: [],
      modelCapabilities: ['video.image-to-video', 'video.reference-to-video'],
    });

    // 新行为：multi-ref + 模型支持 ref-to-video → reference-to-video
    expect(plan.capability).toBe('video.reference-to-video');
    expect(plan.bundle.hasShotImage).toBe(true);
    expect(plan.bundle.hasGridAnchor).toBe(false);
    // bundle 中应含 锚点 / 场景 / 角色 三项
    expect(plan.bundle.items.map(i => i.kind)).toEqual(['shot-anchor', 'scene', 'character']);
    // visualReferenceInputs = 全 bundle items 的 source（references[0..N]）
    expect(plan.visualReferenceInputs).toHaveLength(3);
    expect(plan.visualReferenceInputs[0]).toEqual(createImageAsset('https://cdn.example.com/anchor.png'));
  });

  it('阶段 2：首帧延展模式（first-frame）即使模型支持参考生视频也走图生视频，单图微动语义优先', () => {
    const character: Character = {
      id: 'char-1',
      name: '角色A',
      role: 'protagonist',
      prompt: 'hero',
      media: { costumePhoto: createImageAsset('https://cdn.example.com/char.png') },
    };
    const shot = createShot({
      videoMode: 'first-frame',
      characters: ['char-1'],
      media: {
        images: [createImageAsset('https://cdn.example.com/anchor.png')],
        currentImageIndex: 0,
      },
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [character],
      scenes: [],
      props: [],
      modelCapabilities: ['video.image-to-video', 'video.reference-to-video'],
    });

    expect(plan.capability).toBe('video.image-to-video');
    expect(plan.primaryImageInput).toEqual(createImageAsset('https://cdn.example.com/anchor.png'));
    // 角色图也作 additional（modelCaps 已知）
    expect(plan.additionalReferenceImages).toHaveLength(1);
  });

  it('阶段 2：多参考模式 + 已生成图 + 模型只支持图生视频 → 兼容降级，资产进 additional', () => {
    const character: Character = {
      id: 'char-1',
      name: '角色A',
      role: 'protagonist',
      prompt: 'hero',
      media: { costumePhoto: createImageAsset('https://cdn.example.com/char.png') },
    };
    const shot = createShot({
      videoMode: 'multi-ref',
      characters: ['char-1'],
      media: {
        images: [createImageAsset('https://cdn.example.com/anchor.png')],
        currentImageIndex: 0,
      },
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [character],
      scenes: [],
      props: [],
      modelCapabilities: ['video.image-to-video'],
    });

    // 模型不支持 ref-to-video → 降级到 image-to-video
    expect(plan.capability).toBe('video.image-to-video');
    expect(plan.primaryImageInput).toEqual(createImageAsset('https://cdn.example.com/anchor.png'));
    // 修复"角色图被悄悄丢"暗坑：modelCaps 已知时角色图作 additional
    expect(plan.additionalReferenceImages).toEqual([
      createImageAsset('https://cdn.example.com/char.png'),
    ]);
  });

  it('阶段 2：grid 模式 + multi-ref + 模型支持参考生视频 → reference-to-video，bundle.hasGridAnchor=true', () => {
    const shot = createShot({
      imageMode: 'grid',
      videoMode: 'multi-ref',
      media: {
        images: [createImageAsset('https://cdn.example.com/grid-3x3.png')],
        currentImageIndex: 0,
      },
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [],
      scenes: [],
      props: [],
      modelCapabilities: ['video.reference-to-video', 'video.image-to-video'],
    });

    expect(plan.capability).toBe('video.reference-to-video');
    expect(plan.bundle.hasGridAnchor).toBe(true);
    expect(plan.bundle.items[0].kind).toBe('grid-anchor');
    expect(plan.bundle.items[0].mentionToken).toBe('@grid_anchor');
  });

  it('storyboard 模式 + multi-ref + 模型支持参考生视频 → 当前故事板作 reference anchor', () => {
    const shot = createShot({
      imageMode: 'storyboard',
      videoMode: 'multi-ref',
      media: {
        images: [createImageAsset('https://cdn.example.com/storyboard.png')],
        currentImageIndex: 0,
      },
    });

    const plan = collectShotVideoPlan({
      shot,
      characters: [],
      scenes: [],
      props: [],
      modelCapabilities: ['video.reference-to-video', 'video.image-to-video'],
    });

    expect(plan.capability).toBe('video.reference-to-video');
    expect(plan.bundle.items[0].kind).toBe('storyboard-anchor');
    expect(plan.bundle.items[0].mentionToken).toBe('@storyboard_anchor');
    expect(plan.primaryImageInput).toEqual(createImageAsset('https://cdn.example.com/storyboard.png'));
  });

  it('构建视频请求时保留上游按模型规格归一后的时长', () => {
    const plan = collectShotVideoPlan({
      shot: createShot(),
      characters: [],
      scenes: [],
      props: [],
    });

    expect(buildShotVideoRequest({
      plan,
      prompt: '短镜头',
      duration: 4,
      aspectRatio: '16:9',
    }).options?.duration).toBe(4);

    expect(buildShotVideoRequest({
      plan,
      prompt: '长镜头',
      duration: 18,
      aspectRatio: '16:9',
    }).options?.duration).toBe(18);
  });

  it('能力支持检查会按当前项目选择直接校验，不再回退到其他模型', () => {
    const settings = createSettings();

    const supported = resolveShotVideoCapabilitySupport({
      settings,
      selectionKey: 'koma-suihe-main::seedance-i2v-only',
      capability: 'video.image-to-video',
    });
    expect(supported.disabledReason).toBeUndefined();
    expect(supported.capability).toBe('video.image-to-video');
    expect(supported.resolvedContext?.definition.id).toBe('koma-suihe-itv');
    expect(supported.effectiveSelectionKey).toBe('koma-suihe-main::seedance-i2v-only');

    // 这个模型只声明了 image-to-video，请求 text-to-video 应被拒
    const unsupportedBySelection = resolveShotVideoCapabilitySupport({
      selectionKey: 'koma-suihe-main::seedance-i2v-only',
      settings,
      capability: 'video.text-to-video',
    });
    expect(unsupportedBySelection.disabledReason).toBe('当前选择的模型不支持文生视频，请切换模型');

    // 把全能力渠道（grok-main）从 settings 里过滤掉，只剩 i2v-only 渠道；
    // 此时项目里没有任何渠道支持 reference-to-video → 应报"当前没有配置支持..."
    const unsupportedEverywhere = resolveShotVideoCapabilitySupport({
      settings: {
        ...settings,
        channelConfigs: settings.channelConfigs.filter(config => config.id === 'koma-suihe-main'),
      },
      selectionKey: 'koma-suihe-main::seedance-i2v-only',
      capability: 'video.reference-to-video',
    });
    expect(unsupportedEverywhere.disabledReason).toBe('当前没有配置支持参考生视频的视频模型');
  });

  it('仅配置参考生视频模型时，不会把图生视频兼容成参考生视频', () => {
    const support = resolveShotVideoCapabilitySupport({
      settings: createReferenceOnlySettings(),
      selectionKey: 'ref-main::ref-model-a',
      capability: 'video.image-to-video',
      visualInputCount: 1,
    });

    expect(support.disabledReason).toBe('当前没有配置支持图生视频的视频模型');
    expect(support.requestedCapability).toBe('video.image-to-video');
    expect(support.capability).toBe('video.image-to-video');
    expect(support.capabilityLabel).toBe('图生视频');
    expect(support.effectiveSelectionKey).toBe('ref-main::ref-model-a');
  });

  it('能力支持时返回解析后的模型上下文', () => {
    const support = resolveShotVideoCapabilitySupport({
      settings: createSettings(),
      selectionKey: 'grok-main::grok-imagine-video',
      capability: 'video.reference-to-video',
    });

    expect(support.disabledReason).toBeUndefined();
    expect(support.resolvedContext?.definition.id).toBe('grok2api-imagine-itv');
    expect(support.resolvedContext?.model.id).toBe('grok-imagine-video');
  });
});
