import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../providers', () => {
  return {
    getProjectITVProvider: vi.fn(),
    getProjectTTIProvider: vi.fn(),
    getProjectTTSProvider: vi.fn(),
  };
});

vi.mock('./imageHostingService', () => {
  return {
    uploadBytesToImageHostingWithRetry: vi.fn(),
  };
});

vi.mock('./mediaPersistenceService', () => {
  return {
    persistMediaAsset: vi.fn(async ({ destPath }: any = {}) => ({
      kind: 'video',
      localPath: destPath || '/tmp/out.mp4',
      createdAt: 1,
    })),
  };
});

vi.mock('../store/projectStore', () => ({
  getProjectPath: vi.fn(async (projectId: string) => `/tmp/koma/projects/${projectId}`),
}));

vi.mock('./mediaTaskBindingService', () => {
  return {
    bindOwnerRefMedia: vi.fn(async () => {}),
  };
});

describe('MediaGenerationService.generateVideo - ITV input policy matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('URL-only providers: required remoteUrl fails clearly when image-hosting upload fails', async () => {
    const { getProjectITVProvider } = await import('../providers');
    const { uploadBytesToImageHostingWithRetry } = await import('./imageHostingService');

    (uploadBytesToImageHostingWithRetry as any).mockResolvedValue({ success: false, error: 'no hosting' });

    const start = vi.fn(async () => {
      return { mode: 'immediate', output: { source: 'https://cdn.example.com/out.mp4' } };
    });

    (getProjectITVProvider as any).mockResolvedValue({
      type: 'custom',
      config: { provider: 'custom', apiKey: 'k', baseUrl: 'https://x' },
      validate: () => true,
      testConnection: async () => true,
      start,
    });

    const { MediaGenerationService } = await import('./MediaGenerationService');
    const svc = new MediaGenerationService();

    await expect(svc.generateVideo({
      projectId: 'p1',
      ownerRef: { projectId: 'p1', ownerType: 'shot', ownerId: 's1', slot: 'video' },
      request: {
        capability: 'video.image-to-video',
        prompt: 'p',
        primaryImage: { transport: 'data-url', value: 'data:image/png;base64,AA==' },
        additionalReferences: [],
        options: {},
      } as any,
    })).rejects.toThrow('no hosting');

    expect(start).not.toHaveBeenCalled();
  });

  it('data-url-capable providers: best-effort remoteUrl -> continues with data-url when upload fails', async () => {
    const { getProjectITVProvider } = await import('../providers');
    const { uploadBytesToImageHostingWithRetry } = await import('./imageHostingService');

    (uploadBytesToImageHostingWithRetry as any).mockResolvedValue({ success: false, error: 'no hosting' });

    const start = vi.fn(async () => {
      return { mode: 'immediate', output: { source: 'https://cdn.example.com/out.mp4' } };
    });

    (getProjectITVProvider as any).mockResolvedValue({
      type: 'custom',
      config: { provider: 'custom', apiKey: 'k', baseUrl: 'https://x' },
      validate: () => true,
      testConnection: async () => true,
      assetTransports: { primaryImage: ['remote-url', 'data-url'], additionalReferences: ['remote-url', 'data-url'] },
      start,
    });

    const { MediaGenerationService } = await import('./MediaGenerationService');
    const svc = new MediaGenerationService();

    const out = await svc.generateVideo({
      projectId: 'p1',
      ownerRef: { projectId: 'p1', ownerType: 'shot', ownerId: 's1', slot: 'video' },
      request: {
        capability: 'video.image-to-video',
        prompt: 'p',
        primaryImage: { transport: 'data-url', value: 'data:image/png;base64,AA==' },
        additionalReferences: [],
        options: {},
      } as any,
    });

    expect(start).toHaveBeenCalled();
    expect(out.kind).toBe('video');
  });

  it('text-to-video requests do not require a primary image', async () => {
    const { getProjectITVProvider } = await import('../providers');

    const start = vi.fn(async () => {
      return { mode: 'immediate', output: { source: 'https://cdn.example.com/out.mp4' } };
    });

    (getProjectITVProvider as any).mockResolvedValue({
      type: 'vidu',
      config: { provider: 'vidu', apiKey: 'k', baseUrl: 'https://x' },
      validate: () => true,
      testConnection: async () => true,
      start,
    });

    const { MediaGenerationService } = await import('./MediaGenerationService');
    const svc = new MediaGenerationService();

    const out = await svc.generateVideo({
      projectId: 'p1',
      ownerRef: { projectId: 'p1', ownerType: 'shot', ownerId: 's1', slot: 'video' },
      request: {
        capability: 'video.text-to-video',
        prompt: 'a cinematic sunrise over the ocean',
        options: { duration: 5 },
      } as any,
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'video.text-to-video',
      prompt: 'a cinematic sunrise over the ocean',
      options: { duration: 5 },
      __komaTrace: expect.objectContaining({
        traceId: expect.any(String),
        source: 'media-generation',
        operation: 'media.generate-video',
        debugBody: true,
      }),
    }));
    expect(out.kind).toBe('video');
  });

  it('persists shot-version video immediate results to the selected version path', async () => {
    const { getProjectITVProvider } = await import('../providers');
    const { persistMediaAsset } = await import('./mediaPersistenceService');

    const start = vi.fn(async () => {
      return { mode: 'immediate', output: { source: 'https://cdn.example.com/out.mp4' } };
    });

    (getProjectITVProvider as any).mockResolvedValue({
      type: 'vidu',
      config: { provider: 'vidu', apiKey: 'k', baseUrl: 'https://x' },
      validate: () => true,
      testConnection: async () => true,
      start,
    });

    const { MediaGenerationService } = await import('./MediaGenerationService');
    const svc = new MediaGenerationService();

    const out = await svc.generateVideo({
      projectId: 'p1',
      ownerRef: {
        projectId: 'p1',
        ownerType: 'shot-version',
        ownerId: 'shot-1',
        slot: 'video',
        versionId: 'v2',
      },
      request: {
        capability: 'video.text-to-video',
        prompt: 'p',
        options: {},
      } as any,
    });

    expect(persistMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      destPath: '/tmp/koma/projects/p1/shots/shot-1/versions/v2/video.mp4',
    }));
    expect(out.localPath).toBe('/tmp/koma/projects/p1/shots/shot-1/versions/v2/video.mp4');
  });

  it('recoverTask 把任务记录的渠道模型与能力提交给主进程 handler', async () => {
    // recoverTask 现在走 submitTask → main 主进程 → 委托回 renderer 拿 snapshot。
    // 单测在 jsdom 里跑，主进程不存在；改为 mock 整套 tasks IPC，
    // 验证 submitTask 入参把 selection / channelId / modelId / capability 传对了。
    let submittedRecord: any = null;
    const submitSpy = vi.fn(async (input: any) => {
      submittedRecord = {
        id: 'task-mock-1',
        scope: input.scope,
        type: input.type,
        status: 'completed',
        progress: 100,
        targetKind: input.targetKind,
        targetId: input.targetId,
        payload: {
          ...input.initialPayload,
          input: input.input,
          output: { kind: 'video', localPath: '/tmp/recovered.mp4', createdAt: 1 },
        },
        createdAt: 1,
        updatedAt: 1,
      };
      return submittedRecord;
    });
    const getRecord = vi.fn(async (id: string) => {
      if (submittedRecord?.id === id) return submittedRecord;
      return null;
    });
    let updateListener: any = null;
    (window as any).electronAPI = {
      tasks: {
        submit: submitSpy,
        get: getRecord,
        list: vi.fn(async () => []),
        upsert: vi.fn(async () => null),
        delete: vi.fn(async () => true),
        cancel: vi.fn(async () => true),
        removeByScope: vi.fn(async () => 0),
        removeByTarget: vi.fn(async () => 0),
        gc: vi.fn(async () => ({ purgedByAge: 0, purgedByLimit: 0 })),
        getRetention: vi.fn(async () => ({ retentionDays: 7, perScopeLimit: 200 })),
        setRetention: vi.fn(async () => ({ retentionDays: 7, perScopeLimit: 200 })),
        getWebContentsId: vi.fn(async () => 1),
        onUpdated: vi.fn((cb: any) => {
          updateListener = cb;
          // submit 已经是 completed；用 setTimeout 模拟 broadcast 触发 waitForTaskCompletion
          setTimeout(() => {
            if (updateListener && submittedRecord) {
              updateListener({}, { record: submittedRecord, kind: 'upsert' });
            }
          }, 0);
          return () => { updateListener = null; };
        }),
      },
    };

    const { MediaGenerationService } = await import('./MediaGenerationService');
    const svc = new MediaGenerationService();

    const out = await svc.recoverTask({
      projectId: 'p1',
      task: {
        id: 'task-1',
        projectId: 'p1',
        type: 'itv',
        targetType: 'shot',
        targetId: 'shot-1',
        remoteTaskId: 'remote-1',
        channelId: 'vidu-main',
        modelId: 'vidu-model-a',
        capability: 'video.reference-to-video',
        ownerRef: { projectId: 'p1', ownerType: 'shot', ownerId: 'shot-1', slot: 'video' },
        status: 'processing',
        progress: 50,
        retryCount: 0,
        maxRetries: 3,
        createdAt: 1,
        updatedAt: 1,
      },
      itvSelection: 'runway-main::runway-model-a',
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submitArg = submitSpy.mock.calls[0][0];
    expect(submitArg.type).toBe('itv');
    expect(submitArg.scope).toBe('project:p1');
    expect(submitArg.input).toMatchObject({
      kind: 'video',
      remoteTaskId: 'remote-1',
      rendererHandlerType: 'itv',
      channelId: 'vidu-main',
      modelId: 'vidu-model-a',
      capability: 'video.reference-to-video',
      // selection 由 resolveTaskSelectionKey(task, ttiSelection) 派生：
      // task.channelId/modelId 拼出 'vidu-main::vidu-model-a' 优先于外部 itvSelection
      selection: 'vidu-main::vidu-model-a',
      extra: {
        destPath: undefined,
      },
    });
    expect(out?.kind).toBe('video');

    delete (window as any).electronAPI;
  });

  it('recoverTask carries versioned video destPath for shot-version owners', async () => {
    let submittedRecord: any = null;
    const submitSpy = vi.fn(async (input: any) => {
      submittedRecord = {
        id: 'task-mock-1',
        scope: input.scope,
        type: input.type,
        status: 'completed',
        progress: 100,
        targetKind: input.targetKind,
        targetId: input.targetId,
        payload: {
          ...input.initialPayload,
          input: input.input,
          output: { kind: 'video', localPath: input.input.extra.destPath, createdAt: 1 },
        },
        createdAt: 1,
        updatedAt: 1,
      };
      return submittedRecord;
    });
    const getRecord = vi.fn(async (id: string) => {
      if (submittedRecord?.id === id) return submittedRecord;
      return null;
    });
    let updateListener: any = null;
    (window as any).electronAPI = {
      tasks: {
        submit: submitSpy,
        get: getRecord,
        list: vi.fn(async () => []),
        upsert: vi.fn(async () => null),
        delete: vi.fn(async () => true),
        cancel: vi.fn(async () => true),
        removeByScope: vi.fn(async () => 0),
        removeByTarget: vi.fn(async () => 0),
        gc: vi.fn(async () => ({ purgedByAge: 0, purgedByLimit: 0 })),
        getRetention: vi.fn(async () => ({ retentionDays: 7, perScopeLimit: 200 })),
        setRetention: vi.fn(async () => ({ retentionDays: 7, perScopeLimit: 200 })),
        getWebContentsId: vi.fn(async () => 1),
        onUpdated: vi.fn((cb: any) => {
          updateListener = cb;
          setTimeout(() => {
            if (updateListener && submittedRecord) {
              updateListener({}, { record: submittedRecord, kind: 'upsert' });
            }
          }, 0);
          return () => { updateListener = null; };
        }),
      },
    };

    const { MediaGenerationService } = await import('./MediaGenerationService');
    const svc = new MediaGenerationService();

    const out = await svc.recoverTask({
      projectId: 'p1',
      task: {
        id: 'task-1',
        projectId: 'p1',
        type: 'itv',
        targetType: 'shot',
        targetId: 'shot-1',
        remoteTaskId: 'remote-1',
        channelId: 'vidu-main',
        modelId: 'vidu-model-a',
        capability: 'video.reference-to-video',
        ownerRef: {
          projectId: 'p1',
          ownerType: 'shot-version',
          ownerId: 'shot-1',
          slot: 'video',
          versionId: 'v3',
        },
        status: 'processing',
        progress: 50,
        retryCount: 0,
        maxRetries: 3,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0][0].input.extra.destPath)
      .toBe('/tmp/koma/projects/p1/shots/shot-1/versions/v3/video.mp4');
    expect(out?.localPath).toBe('/tmp/koma/projects/p1/shots/shot-1/versions/v3/video.mp4');

    delete (window as any).electronAPI;
  });

});
