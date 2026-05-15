import { describe, expect, it } from 'vitest';
import type { Character, Prop, Scene, Shot, StoredMediaAsset } from '../../types';
import { buildShotReferenceBundle } from './builder';

function asset(remoteUrl: string, metadata?: Record<string, unknown>): StoredMediaAsset {
  return {
    kind: 'image',
    remoteUrl,
    metadata,
    createdAt: 1,
  };
}

function shotOf(partial: Partial<Shot>): Shot {
  return {
    id: 'shot-1',
    scriptLines: [{ id: 'l1', text: '宿舍里周明躺在床上看手机' }],
    shotType: 'medium',
    cameraMovement: 'static',
    duration: 6,
    imagePrompt: '',
    videoPrompt: '',
    characters: [],
    scenes: [],
    props: [],
    media: {},
    ...partial,
  };
}

const charZhouming: Character = {
  id: 'char-zhouming',
  name: '周明',
  appearance: '',
  description: '',
  prompt: '',
  media: { costumePhoto: asset('https://example.com/zhouming.png') },
} as unknown as Character;

const charLina: Character = {
  id: 'char-lina',
  name: '丽娜',
  appearance: '',
  description: '',
  prompt: '',
  media: { costumePhoto: asset('https://example.com/lina.png') },
} as unknown as Character;

const sceneDorm: Scene = {
  id: 'scene-dorm',
  name: '宿舍',
  description: '',
  prompt: '',
  media: { previewImage: asset('https://example.com/dorm.png') },
} as unknown as Scene;

const propPhone: Prop = {
  id: 'prop-phone',
  name: '手机',
  description: '',
  prompt: '',
  media: { previewImage: asset('https://example.com/phone.png') },
} as unknown as Prop;

describe('buildShotReferenceBundle — normal mode', () => {
  it('已生成图作 shot-anchor 占据 references[0]，资产图按 scene → character → prop 顺序排列', () => {
    const shot = shotOf({
      imageMode: 'normal',
      characters: ['char-zhouming'],
      scenes: ['scene-dorm'],
      props: ['prop-phone'],
      media: {
        images: [asset('https://example.com/shot1-image.png')],
        currentImageIndex: 0,
      },
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [charZhouming],
      scenes: [sceneDorm],
      props: [propPhone],
    });

    expect(bundle.items.map(i => i.kind)).toEqual([
      'shot-anchor',
      'scene',
      'character',
      'prop',
    ]);
    expect(bundle.items[0].mentionToken).toBe('@shot_anchor');
    expect(bundle.items[1].mentionToken).toBe('@scene_scene-dorm');
    expect(bundle.items[2].mentionToken).toBe('@char_char-zhouming');
    expect(bundle.items[3].mentionToken).toBe('@prop_prop-phone');
    expect(bundle.hasShotImage).toBe(true);
    expect(bundle.hasGridAnchor).toBe(false);
  });

  it('没有已生成图时 bundle 不含 anchor 项', () => {
    const shot = shotOf({
      imageMode: 'normal',
      characters: ['char-zhouming'],
      scenes: ['scene-dorm'],
    });
    const bundle = buildShotReferenceBundle({
      shot,
      characters: [charZhouming],
      scenes: [sceneDorm],
      props: [],
    });
    expect(bundle.items.find(i => i.kind === 'shot-anchor')).toBeUndefined();
    expect(bundle.hasShotImage).toBe(false);
    expect(bundle.items.map(i => i.kind)).toEqual(['scene', 'character']);
  });

  it('资产没有参考图时仍保留 mention fallback 标签', () => {
    const propNoImage: Prop = {
      id: 'prop-book',
      name: '字典',
      description: '',
      prompt: '',
      media: {},
    } as unknown as Prop;
    const shot = shotOf({
      imageMode: 'normal',
      props: ['prop-phone', 'prop-book'],
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [],
      scenes: [],
      props: [propPhone, propNoImage],
    });

    expect(bundle.items.map(item => item.mentionToken)).toEqual(['@prop_prop-phone']);
    expect(bundle.mentionFallbacks).toEqual([
      { mentionToken: '@prop_prop-phone', label: '手机' },
      { mentionToken: '@prop_prop-book', label: '字典' },
    ]);
  });

  it('真实资产 ID 已含类型前缀时，mentionToken 不重复拼接前缀', () => {
    const prefixedScene: Scene = {
      id: 'scene_1778207015305_2',
      name: '深山木屋内部',
      media: { previewImage: asset('https://example.com/scene-prefixed.png') },
    } as unknown as Scene;
    const prefixedChar: Character = {
      id: 'char_1778207028644_0',
      name: '我',
      media: { costumePhoto: asset('https://example.com/char-prefixed.png') },
    } as unknown as Character;
    const prefixedProp: Prop = {
      id: 'prop_1778207006838_1',
      name: '红烧肉',
      media: { previewImage: asset('https://example.com/prop-prefixed.png') },
    } as unknown as Prop;
    const shot = shotOf({
      imageMode: 'normal',
      characters: ['char_1778207028644_0'],
      scenes: ['scene_1778207015305_2'],
      props: ['prop_1778207006838_1'],
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [prefixedChar],
      scenes: [prefixedScene],
      props: [prefixedProp],
    });

    expect(bundle.items.map(item => item.mentionToken)).toEqual([
      '@scene_1778207015305_2',
      '@char_1778207028644_0',
      '@prop_1778207006838_1',
    ]);
    expect(bundle.items.map(item => item.mentionToken).join(' ')).not.toContain('@prop_prop_');
    expect(bundle.mentionFallbacks).toEqual([
      { mentionToken: '@scene_1778207015305_2', label: '深山木屋内部' },
      { mentionToken: '@char_1778207028644_0', label: '我' },
      { mentionToken: '@prop_1778207006838_1', label: '红烧肉' },
    ]);
  });

  it('忽略 images[] 中带 metadata.gridCell 的拆分子图（历史路径）', () => {
    const shot = shotOf({
      imageMode: 'normal',
      media: {
        images: [
          asset('https://example.com/cell1.png', { gridCell: 1 }),
          asset('https://example.com/cell2.png', { gridCell: 2 }),
        ],
        currentImageIndex: 0,
      },
    });
    const bundle = buildShotReferenceBundle({
      shot,
      characters: [],
      scenes: [],
      props: [],
    });
    expect(bundle.hasShotImage).toBe(false);
    expect(bundle.items).toHaveLength(0);
  });
});

describe('buildShotReferenceBundle — grid mode', () => {
  it('grid 模式取 images[currentImageIndex] 作 grid-anchor，hasGridAnchor=true', () => {
    // 正常 grid 数据：3×3 整图存在 images[0]（normalizeShotMediaState 会把
    // 老 shot.media.gridImage 字段合并到这里，字段本身被剥掉）。
    const shot = shotOf({
      imageMode: 'grid',
      characters: ['char-zhouming'],
      scenes: ['scene-dorm'],
      media: {
        images: [asset('https://example.com/shot1-grid-3x3.png')],
        currentImageIndex: 0,
      },
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [charZhouming],
      scenes: [sceneDorm],
      props: [],
    });

    expect(bundle.items[0].kind).toBe('grid-anchor');
    expect(bundle.items[0].mentionToken).toBe('@grid_anchor');
    expect(bundle.hasGridAnchor).toBe(true);
    expect(bundle.hasShotImage).toBe(true);
    expect(bundle.items.find(i => i.kind === 'shot-anchor')).toBeUndefined();
  });

  it('grid 模式 + images[] 里只有拆分子图（历史数据）时不产出 anchor', () => {
    const shot = shotOf({
      imageMode: 'grid',
      scenes: ['scene-dorm'],
      media: {
        images: [
          asset('https://example.com/cell1.png', { gridCell: 1 }),
          asset('https://example.com/cell2.png', { gridCell: 2 }),
        ],
        currentImageIndex: 0,
      },
    });
    const bundle = buildShotReferenceBundle({
      shot,
      characters: [],
      scenes: [sceneDorm],
      props: [],
    });
    expect(bundle.hasGridAnchor).toBe(false);
    expect(bundle.hasShotImage).toBe(false);
    expect(bundle.items[0].kind).toBe('scene');
  });

  it('grid-4 模式取 images[0] 作 grid-anchor，bundle.gridCellCount=4', () => {
    const shot = shotOf({
      imageMode: 'grid-4',
      media: {
        images: [asset('https://example.com/shot1-grid-2x2.png')],
        currentImageIndex: 0,
      },
    });
    const bundle = buildShotReferenceBundle({
      shot,
      characters: [],
      scenes: [],
      props: [],
    });
    expect(bundle.items[0].kind).toBe('grid-anchor');
    expect(bundle.items[0].label).toContain('四宫格');
    expect(bundle.gridCellCount).toBe(4);
  });

  it('grid-9 模式 bundle.gridCellCount=9', () => {
    const shot = shotOf({
      imageMode: 'grid-9',
      media: {
        images: [asset('https://example.com/grid-9.png')],
        currentImageIndex: 0,
      },
    });
    const bundle = buildShotReferenceBundle({ shot, characters: [], scenes: [], props: [] });
    expect(bundle.gridCellCount).toBe(9);
  });

  it('老 imageMode="grid" 视作 grid-9，bundle.gridCellCount=9', () => {
    const shot = shotOf({
      imageMode: 'grid',
      media: {
        images: [asset('https://example.com/legacy-grid.png')],
        currentImageIndex: 0,
      },
    });
    const bundle = buildShotReferenceBundle({ shot, characters: [], scenes: [], props: [] });
    expect(bundle.gridCellCount).toBe(9);
  });

  it('grid 模式 + 完全没有图（还没生成）时 bundle 无 anchor，hasGridAnchor=false', () => {
    const shot = shotOf({
      imageMode: 'grid',
      scenes: ['scene-dorm'],
      media: {},
    });
    const bundle = buildShotReferenceBundle({
      shot,
      characters: [],
      scenes: [sceneDorm],
      props: [],
    });
    expect(bundle.hasGridAnchor).toBe(false);
    expect(bundle.hasShotImage).toBe(false);
    expect(bundle.items[0].kind).toBe('scene');
  });
});

describe('buildShotReferenceBundle — storyboard mode', () => {
  it('storyboard 模式取当前图片作 storyboard-anchor', () => {
    const shot = shotOf({
      imageMode: 'storyboard',
      media: {
        images: [asset('https://example.com/storyboard-current.png')],
        currentImageIndex: 0,
      },
    });

    const bundle = buildShotReferenceBundle({ shot, characters: [], scenes: [], props: [] });

    expect(bundle.items[0].kind).toBe('storyboard-anchor');
    expect(bundle.items[0].mentionToken).toBe('@storyboard_anchor');
    expect(bundle.hasShotImage).toBe(true);
    expect(bundle.hasGridAnchor).toBe(false);
  });

  it('storyboard 模式默认继承上一张故事板图作为 previous-storyboard-anchor', () => {
    const previous = shotOf({
      id: 'shot-prev',
      imageMode: 'storyboard',
      media: {
        images: [asset('https://example.com/storyboard-prev.png')],
        currentImageIndex: 0,
      },
    });
    const current = shotOf({
      id: 'shot-current',
      imageMode: 'storyboard',
      characters: ['char-zhouming'],
    });

    const bundle = buildShotReferenceBundle({
      shot: current,
      allShots: [previous, current],
      characters: [charZhouming],
      scenes: [],
      props: [],
    });

    expect(bundle.items.map(item => item.kind)).toEqual([
      'previous-storyboard-anchor',
      'character',
    ]);
    expect(bundle.items[0].mentionToken).toBe('@previous_storyboard_anchor');
  });

  it('storyboard 模式继承上一故事板时使用上一分镜当前选中的版本', () => {
    const previousV1 = asset('https://example.com/storyboard-prev-v1.png');
    const previousV2 = asset('https://example.com/storyboard-prev-v2.png');
    const previous = shotOf({
      id: 'shot-prev',
      imageMode: 'storyboard',
      media: {
        images: [previousV1, previousV2],
        currentImageIndex: 1,
      },
    });
    const current = shotOf({
      id: 'shot-current',
      imageMode: 'storyboard',
    });

    const bundle = buildShotReferenceBundle({
      shot: current,
      allShots: [previous, current],
      characters: [],
      scenes: [],
      props: [],
    });

    expect(bundle.items[0].kind).toBe('previous-storyboard-anchor');
    expect(bundle.items[0].source).toBe(previousV2);
  });

  it('storyboard 模式续上板时继承上一条有图分镜，即使上一条不是 storyboard 模式', () => {
    const previousV1 = asset('https://example.com/normal-prev-v1.png');
    const previousV2 = asset('https://example.com/normal-prev-v2.png');
    const previous = shotOf({
      id: 'shot-prev',
      imageMode: 'normal',
      media: {
        images: [previousV1, previousV2],
        currentImageIndex: 1,
      },
    });
    const current = shotOf({
      id: 'shot-current',
      imageMode: 'storyboard',
    });

    const bundle = buildShotReferenceBundle({
      shot: current,
      allShots: [previous, current],
      characters: [],
      scenes: [],
      props: [],
    });

    expect(bundle.items[0].kind).toBe('previous-storyboard-anchor');
    expect(bundle.items[0].mentionToken).toBe('@previous_storyboard_anchor');
    expect(bundle.items[0].source).toBe(previousV2);
  });

  it('storyboard 模式续上板时若当前选中图是历史拆分子图，会回退到上一条可用整图', () => {
    const previousGridCell = asset('https://example.com/grid-cell.png', { gridCell: 1 });
    const previousWhole = asset('https://example.com/previous-whole.png');
    const previous = shotOf({
      id: 'shot-prev',
      imageMode: 'grid',
      media: {
        images: [previousGridCell, previousWhole],
        currentImageIndex: 0,
      },
    });
    const current = shotOf({
      id: 'shot-current',
      imageMode: 'storyboard',
    });

    const bundle = buildShotReferenceBundle({
      shot: current,
      allShots: [previous, current],
      characters: [],
      scenes: [],
      props: [],
    });

    expect(bundle.items[0].kind).toBe('previous-storyboard-anchor');
    expect(bundle.items[0].source).toBe(previousWhole);
  });

  it('storyboard 模式关闭继承时不加入上一故事板图', () => {
    const previous = shotOf({
      id: 'shot-prev',
      imageMode: 'storyboard',
      media: {
        images: [asset('https://example.com/storyboard-prev.png')],
        currentImageIndex: 0,
      },
    });
    const current = shotOf({
      id: 'shot-current',
      imageMode: 'storyboard',
      inheritPreviousStoryboard: false,
      characters: ['char-zhouming'],
    });

    const bundle = buildShotReferenceBundle({
      shot: current,
      allShots: [previous, current],
      characters: [charZhouming],
      scenes: [],
      props: [],
    });

    expect(bundle.items.map(item => item.kind)).toEqual(['character']);
    expect(bundle.items.some(item => item.kind === 'previous-storyboard-anchor')).toBe(false);
  });
});

describe('buildShotReferenceBundle — 配额裁剪', () => {
  it('maxRefs 限制时按 priority 保留 anchor + 主场景 + 主角，其它被截掉', () => {
    const shot = shotOf({
      imageMode: 'normal',
      characters: ['char-zhouming', 'char-lina'],
      scenes: ['scene-dorm'],
      props: ['prop-phone'],
      media: {
        images: [asset('https://example.com/shot1-image.png')],
        currentImageIndex: 0,
      },
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [charZhouming, charLina],
      scenes: [sceneDorm],
      props: [propPhone],
      options: { maxRefs: 3 }, // 锚点 + 场景 + 主角
    });

    expect(bundle.items).toHaveLength(3);
    expect(bundle.items.map(i => i.kind)).toEqual(['shot-anchor', 'scene', 'character']);
    expect(bundle.items[2].id).toBe('char-zhouming'); // 主角保留
    expect(bundle.capacity.truncatedCount).toBe(2);
    expect(bundle.capacity.truncatedKinds).toContain('character');
    expect(bundle.capacity.truncatedKinds).toContain('prop');
  });

  it('shot-anchor 在低 maxRefs（1）时仍必保', () => {
    const shot = shotOf({
      imageMode: 'normal',
      characters: ['char-zhouming'],
      scenes: ['scene-dorm'],
      media: {
        images: [asset('https://example.com/shot1-image.png')],
        currentImageIndex: 0,
      },
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [charZhouming],
      scenes: [sceneDorm],
      props: [],
      options: { maxRefs: 1 },
    });

    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0].kind).toBe('shot-anchor');
    expect(bundle.capacity.truncatedCount).toBe(2);
  });
});

describe('buildShotReferenceBundle — 去重', () => {
  it('同一资产被多个 shot 字段引用时，bundle 中只占一个槽位', () => {
    const sharedAsset = asset('https://example.com/shared.png');
    const charA: Character = {
      id: 'char-a',
      name: 'A',
      media: { costumePhoto: sharedAsset },
    } as unknown as Character;
    const sceneA: Scene = {
      id: 'scene-a',
      name: 'A',
      // 故意指向同一份 asset
      media: { previewImage: sharedAsset },
    } as unknown as Scene;

    const shot = shotOf({
      imageMode: 'normal',
      characters: ['char-a'],
      scenes: ['scene-a'],
      media: {},
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [charA],
      scenes: [sceneA],
      props: [],
    });

    expect(bundle.items).toHaveLength(1);
    // scene 优先级高于 character，所以保留 scene 项
    expect(bundle.items[0].kind).toBe('scene');
  });
});

describe('buildShotReferenceBundle — 用户上传参考图', () => {
  it('shot.media.references[] 作为 user-upload 项追加在末尾，最低优先级', () => {
    const shot = shotOf({
      imageMode: 'normal',
      scenes: ['scene-dorm'],
      media: {
        images: [asset('https://example.com/shot1-image.png')],
        currentImageIndex: 0,
        references: [
          asset('https://example.com/user-ref-1.png'),
          asset('https://example.com/user-ref-2.png'),
        ],
      },
    });

    const bundle = buildShotReferenceBundle({
      shot,
      characters: [],
      scenes: [sceneDorm],
      props: [],
    });

    const kinds = bundle.items.map(i => i.kind);
    expect(kinds[0]).toBe('shot-anchor');
    expect(kinds[1]).toBe('scene');
    expect(kinds.slice(2)).toEqual(['user-upload', 'user-upload']);
    expect(bundle.items[2].mentionToken).toBe('@user_0');
    expect(bundle.items[3].mentionToken).toBe('@user_1');
  });
});
