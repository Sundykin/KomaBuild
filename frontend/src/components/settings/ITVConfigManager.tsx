/// <reference types="vite/client" />
import React, { useCallback, useMemo, useRef } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
} from 'antd';
import {
  AppstoreOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  LoadingOutlined,
  PlusOutlined,
  SettingOutlined,
  StarFilled,
  StarOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { AppSettings, ITVModelConfig } from '../../types';
import { buildITVConfigFromContext } from '../../providers/channel/resolver';
import type { ChannelConfig, ChannelModelDefinition } from '../../providers/channel/types';
import {
  addChannelConfig,
  deleteChannelConfig,
  generateId,
  setDefaultMediaModelSelection,
  updateChannelConfig,
} from '../../store/globalStore';
import { createITVProvider } from '../../providers/itv';
import { ProviderPluginModal } from '../plugins/ProviderPluginModal';
import { ChannelModelsEditor } from './ChannelModelsEditor';
import {
  buildChannelFormValues,
  buildManagedChannelCards,
  getPreferredChannelModelId,
  listBuiltInChannelOptions,
} from './channelManagerShared';
import {
  getSuggestedITVFieldDefaults,
  getSuggestedITVModels,
  hasConfiguredITVModels,
  normalizeITVModelsForProvider,
  shouldReplaceITVModelsOnProviderChange,
} from './itvProviderSuggestions';
import { useMediaConfigManager } from './useMediaConfigManager';
import {
  isKomaActivationManagedChannel,
  withKomaActivationChannelMarker,
} from '../../utils/activationManagedChannels';

interface ITVConfigManagerProps {
  onConfigChange?: () => void;
}

const CAPABILITY_LABELS: Record<string, string> = {
  'video.text-to-video': '文生视频',
  'video.image-to-video': '图生视频',
  'video.reference-to-video': '参考生视频',
  'video.start-end-to-video': '首尾帧视频',
};

function getProviderColor(provider: string) {
  switch (provider) {
    case 'vidu': return 'volcano';
    case 'seedance': return 'cyan';
    case 'runway': return 'blue';
    case 'kling': return 'purple';
    case 'pika': return 'magenta';
    case 'sora2': return 'geekblue';
    case 'comfyui-animatediff': return 'orange';
    case 'grok2api-imagine-itv': return 'green';
    case 'openai-video': return 'gold';
    default: return 'default';
  }
}

function readLockedBaseUrl(
  definition?: { configSchema?: Record<string, unknown> },
): string | undefined {
  const schema = definition?.configSchema as
    | { baseUrlLocked?: boolean; fixedBaseUrl?: string; properties?: { baseUrl?: { default?: string } } }
    | undefined;
  if (!schema?.baseUrlLocked) return undefined;
  return schema.fixedBaseUrl || schema.properties?.baseUrl?.default || undefined;
}

function getChannelDefaults(definition?: ReturnType<typeof listBuiltInChannelOptions>[number]) {
  if (!definition) {
    return {};
  }

  const schemaProperties = (definition.configSchema as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties || {};
  const defaults = Object.fromEntries(
    Object.entries(schemaProperties)
      .filter(([, field]) => field?.default !== undefined)
      .map(([key, field]) => [key, field.default]),
  );

  return {
    name: definition.name,
    ...defaults,
  };
}

export const ITVConfigManager: React.FC<ITVConfigManagerProps> = ({ onConfigChange }) => {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const channelDefinitions = useMemo(() => listBuiltInChannelOptions('itv'), []);
  const definitionMap = useMemo(
    () => new Map(channelDefinitions.map((definition) => [definition.id, definition])),
    [channelDefinitions],
  );

  const loadBuiltins = useCallback(
    (settings: AppSettings) => buildManagedChannelCards(settings, 'itv', buildITVConfigFromContext),
    [],
  );

  const {
    configs,
    pluginChannels,
    settings,
    loading,
    modalVisible,
    setModalVisible,
    editingChannel,
    setEditingChannel,
    testingId,
    setTestingId,
    form,
    pluginModalVisible,
    activePluginId,
    loadConfigs,
    openPluginModal,
    closePluginModal,
    handlePluginConfigSaved,
  } = useMediaConfigManager<ITVModelConfig>('itv', loadBuiltins, onConfigChange);

  const showChannelConfigCreateEntry = false;
  const watchedProviderType = Form.useWatch('providerType', form) as string | undefined;
  const isEditingActivationChannel = isKomaActivationManagedChannel(editingChannel);
  const currentProviderType = isEditingActivationChannel ? editingChannel?.providerType : watchedProviderType;
  const previousProviderTypeRef = useRef<string | undefined>(undefined);
  const editingHasStoredApiKey = Boolean(editingChannel && (editingChannel.providerConfig as Record<string, unknown> | undefined)?.hasApiKey);
  const currentDefinition = currentProviderType ? definitionMap.get(currentProviderType) : undefined;
  const watchedModels = Form.useWatch('models', form) as Array<Partial<ChannelModelDefinition>> | undefined;
  const modelOptions = useMemo(() => (
    (watchedModels || [])
      .filter((model) => Boolean(model && model.id))
      .map((model) => ({
        label: (String(model.label || '').trim()
          || String(model.providerModelName || '').trim()
          || String(model.id || '').trim()),
        value: String(model.id),
      }))
  ), [watchedModels]);

  const normalizeModels = useCallback((raw: unknown): ChannelModelDefinition[] => {
    const models = (Array.isArray(raw) ? raw : []) as Array<Partial<ChannelModelDefinition>>;
    if (models.length === 0) {
      throw new Error('请至少添加一个模型');
    }

    return models.map((item) => {
      const providerModelName = String(item.providerModelName || '').trim();
      if (!providerModelName) {
        throw new Error('模型名称不能为空');
      }
      const label = String(item.label || '').trim() || providerModelName;
      const id = String(item.id || '').trim() || generateId();
      const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
      if (capabilities.length === 0) {
        throw new Error('请为每个模型至少选择一个能力');
      }

      return {
        id,
        label,
        providerModelName,
        capabilities,
        defaults: item.defaults && typeof item.defaults === 'object' && !Array.isArray(item.defaults)
          ? { ...(item.defaults as Record<string, unknown>) }
          : undefined,
      };
    });
  }, []);

  const openModal = useCallback((config?: typeof configs[number]) => {
    if (config) {
      setEditingChannel(config.channel);
      const formValues = buildChannelFormValues(config.channel, config.definition);
      const suggestedModels = getSuggestedITVModels(config.channel.providerType);
      const shouldUseSuggestedModels = suggestedModels.length > 0 && !hasConfiguredITVModels(config.channel.models);
      const models = normalizeITVModelsForProvider(
        shouldUseSuggestedModels ? suggestedModels : formValues.models,
        config.channel.providerType,
      );
      const defaultModelId = models.some((model) => model.id === formValues.defaultModelId)
        ? formValues.defaultModelId
        : models[0]?.id;
      previousProviderTypeRef.current = config.channel.providerType;
      form.setFieldsValue({
        ...getSuggestedITVFieldDefaults(config.channel.providerType),
        ...formValues,
        models,
        defaultModelId,
      });
    } else {
      const firstDefinition = channelDefinitions[0];
      const suggestedModels = getSuggestedITVModels(firstDefinition?.id);
      const modelId = suggestedModels[0]?.id || generateId();
      setEditingChannel(null);
      form.resetFields();
      previousProviderTypeRef.current = firstDefinition?.id;
      form.setFieldsValue({
        providerType: firstDefinition?.id,
        ...getChannelDefaults(firstDefinition),
        ...getSuggestedITVFieldDefaults(firstDefinition?.id),
        models: suggestedModels.length > 0
          ? suggestedModels
          : [{
              id: modelId,
              providerModelName: '',
              label: '',
              capabilities: ['video.image-to-video'],
            }],
        defaultModelId: modelId,
      });
    }
    setModalVisible(true);
  }, [channelDefinitions, configs, form, setEditingChannel, setModalVisible]);

  const handleProviderChange = useCallback((providerType: string) => {
    const definition = definitionMap.get(providerType);
    if (!definition) {
      return;
    }

    const existingModels = form.getFieldValue('models');
    const suggestedModels = getSuggestedITVModels(providerType);
    const previousProviderType = previousProviderTypeRef.current;
    const shouldReplace = suggestedModels.length > 0 && shouldReplaceITVModelsOnProviderChange(
      existingModels,
      providerType,
      previousProviderType,
    );
    const normalizedModels = normalizeITVModelsForProvider(
      shouldReplace
        ? suggestedModels
        : Array.isArray(existingModels) && existingModels.length > 0
          ? existingModels
          : [{
              id: generateId(),
              providerModelName: '',
              label: '',
              capabilities: ['video.image-to-video'],
            }],
      providerType,
    );

    const currentDefaultModelId = String(form.getFieldValue('defaultModelId') || '');
    const nextDefaultModelId = currentDefaultModelId && normalizedModels.some((model: any) => String(model?.id) === currentDefaultModelId)
      ? currentDefaultModelId
      : String(normalizedModels[0]?.id || '');

    const previousName = form.getFieldValue('name');
    previousProviderTypeRef.current = providerType;
    form.setFieldsValue({
      providerType,
      name: previousName || definition.name,
      ...getChannelDefaults(definition),
      ...getSuggestedITVFieldDefaults(providerType),
      models: normalizedModels,
      defaultModelId: nextDefaultModelId,
    });
  }, [definitionMap, form]);

  React.useEffect(() => {
    previousProviderTypeRef.current = currentProviderType || previousProviderTypeRef.current;
  }, [currentProviderType]);

  React.useEffect(() => {
    const models = watchedModels || [];
    if (models.length === 0) {
      return;
    }
    const current = String(form.getFieldValue('defaultModelId') || '');
    if (!current || !models.some((item) => String(item?.id || '') === current)) {
      const next = String(models[0]?.id || '');
      if (next) {
        form.setFieldValue('defaultModelId', next);
      }
    }
  }, [form, watchedModels]);

  const handleSave = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const isActivationChannel = isKomaActivationManagedChannel(editingChannel);
      const effectiveProviderType = isActivationChannel && editingChannel
        ? editingChannel.providerType
        : values.providerType;
      const definition = definitionMap.get(effectiveProviderType);
      if (!definition) {
        throw new Error('未找到对应的视频渠道定义');
      }

      const models = normalizeITVModelsForProvider(normalizeModels(values.models), effectiveProviderType);
      const modelIdSet = new Set(models.map((model) => model.id));
      const defaultModelId = modelIdSet.has(values.defaultModelId)
        ? values.defaultModelId
        : models[0]?.id;
      if (!defaultModelId) throw new Error('请至少添加一个模型');

      const lockedBaseUrl = readLockedBaseUrl(definition);
      const providerConfig = isActivationChannel && editingChannel
        ? withKomaActivationChannelMarker({
            baseUrl: editingChannel.providerConfig?.baseUrl,
            promptProtocol: values.promptProtocol || undefined,
            defaultDuration: values.defaultDuration || undefined,
            defaultResolution: values.defaultResolution || undefined,
          })
        : {
            // 若渠道定义声明 baseUrlLocked，强制使用 schema 中的固定域名，
            // 防止用户绕过 UI 直接改写 localStorage。
            baseUrl: lockedBaseUrl || values.baseUrl,
            apiKey: values.apiKey,
            promptProtocol: values.promptProtocol || undefined,
            defaultDuration: values.defaultDuration || undefined,
            defaultResolution: values.defaultResolution || undefined,
          };

      const payload = {
        name: isActivationChannel && editingChannel ? editingChannel.name : values.name,
        description: definition.description,
        category: 'itv' as const,
        providerType: effectiveProviderType,
        providerConfig,
        defaultModelId,
        models,
        enabled: true,
        source: 'builtin' as const,
      };

      const saved = editingChannel
        ? await updateChannelConfig(editingChannel.id, payload)
        : await addChannelConfig(payload);

      if (!saved) {
        throw new Error('保存渠道配置失败');
      }

      const shouldUpdateDefault = !settings?.mediaDefaults?.itv
        || settings.mediaDefaults.itv.channelId === saved.id;
      if (shouldUpdateDefault) {
        await setDefaultMediaModelSelection('itv', { channelId: saved.id, modelId: defaultModelId });
      }

      message.success(editingChannel ? t('settings.configUpdated') : t('settings.configAdded'));
      setModalVisible(false);
      await loadConfigs();
      onConfigChange?.();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(`${t('common.saveFailed')}: ${err?.message || String(err)}`);
    }
  }, [definitionMap, editingChannel, form, loadConfigs, message, onConfigChange, setModalVisible, settings?.mediaDefaults?.itv, t]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteChannelConfig(id);
      message.success(t('settings.configDeleted'));
      await loadConfigs();
      onConfigChange?.();
    } catch (err: any) {
      message.error(`${t('error.deleteFailed')}: ${err?.message || String(err)}`);
    }
  }, [loadConfigs, message, onConfigChange, t]);

  const handleSetDefault = useCallback(async (channel: ChannelConfig, modelId?: string) => {
    if (!modelId) {
      message.error('当前渠道没有可用模型');
      return;
    }

    try {
      await setDefaultMediaModelSelection('itv', { channelId: channel.id, modelId });
      message.success(t('settings.defaultSet'));
      await loadConfigs();
      onConfigChange?.();
    } catch (err: any) {
      message.error(`${t('common.error')}: ${err?.message || String(err)}`);
    }
  }, [loadConfigs, message, onConfigChange, t]);

  const handleSetPluginDefault = useCallback(async (channel: ChannelConfig) => {
    if (!channel.defaultModelId) {
      message.warning('插件渠道尚未声明默认模型');
      return;
    }

    await handleSetDefault(channel, channel.defaultModelId);
  }, [handleSetDefault, message]);

  const handleTestConnection = useCallback(async (config: typeof configs[number]) => {
    setTestingId(config.channel.id);
    try {
      const provider = createITVProvider(config.resolvedConfig);
      if (!provider.validate()) {
        throw new Error(t('settings.configValidationFailed'));
      }
      const success = await provider.testConnection();
      if (success) {
        message.success(`"${config.channel.name}" ${t('settings.connectionSuccess')}`);
      } else {
        message.error(`"${config.channel.name}" ${t('settings.connectionFailedCheck')}`);
      }
    } catch (err: any) {
      message.error(`${t('settings.connectionFailed')}: ${err?.message || String(err)}`);
    } finally {
      setTestingId(null);
    }
  }, [message, setTestingId, t]);

  const renderModelTags = useCallback((models: ChannelModelDefinition[], defaultModelId?: string) => (
    <Space wrap size={[6, 6]}>
      {models.map((model) => (
        <Tag key={model.id} color={model.id === defaultModelId ? 'gold' : 'default'}>
          {model.label}
        </Tag>
      ))}
    </Space>
  ), []);

  const renderCapabilityTags = useCallback((models: ChannelModelDefinition[]) => {
    const capabilities = Array.from(new Set(models.flatMap((model) => model.capabilities)));
    return (
      <Space wrap size={[6, 6]}>
        {capabilities.map((capability) => (
          <Tag key={capability} color="cyan">
            {CAPABILITY_LABELS[capability] || capability}
          </Tag>
        ))}
      </Space>
    );
  }, []);

  return (
    <div className="settings-manager">
      <div className="settings-manager-toolbar">
        <div className="settings-toolbar-meta">
          <span>
            {t('settings.itvConfigured', { count: configs.length })}
            {pluginChannels.length > 0 && <span>，{t('settings.pluginChannels', { count: pluginChannels.length })}</span>}
          </span>
        </div>
        {showChannelConfigCreateEntry && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
            {t('settings.addConfig')}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="settings-loading-state">
          <Spin />
        </div>
      ) : configs.length === 0 && pluginChannels.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('settings.noITVConfigs')}
          className="settings-empty-state"
        >
          {showChannelConfigCreateEntry && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
              {t('settings.addBuiltinService')}
            </Button>
          )}
        </Empty>
      ) : (
        <Row gutter={[12, 12]}>
          {configs.map((config) => {
            const preferredModelId = getPreferredChannelModelId(config.channel, config.definition);
            return (
              <Col key={config.channel.id} xs={24} md={12} xl={8}>
                <Card
                  size="small"
                  className="settings-config-card"
                  title={(
                    <Space>
                      {config.isDefault ? (
                        <StarFilled className="settings-default-star" />
                      ) : (
                        <Tooltip title={t('settings.setAsDefault')}>
                          <StarOutlined
                            className="settings-default-star-button"
                            onClick={() => handleSetDefault(config.channel, preferredModelId)}
                          />
                        </Tooltip>
                      )}
                      <VideoCameraOutlined />
                      <span>{config.channel.name}</span>
                      <Tag color={getProviderColor(config.definition.id)}>{config.definition.name}</Tag>
                    </Space>
                  )}
                  extra={(
                    <Space size="small">
                      <Tooltip title={t('settings.testConnection')}>
                        <Button
                          type="text"
                          size="small"
                          icon={testingId === config.channel.id ? <LoadingOutlined /> : <CheckCircleOutlined />}
                          onClick={() => handleTestConnection(config)}
                          disabled={testingId === config.channel.id}
                        />
                      </Tooltip>
                      <Tooltip title={t('common.edit')}>
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => openModal(config)}
                        />
                      </Tooltip>
                      <Popconfirm
                        title={t('settings.confirmDeleteConfig')}
                        onConfirm={() => handleDelete(config.channel.id)}
                        okText={t('common.delete')}
                        cancelText={t('common.cancel')}
                      >
                        <Tooltip title={t('common.delete')}>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                        </Tooltip>
                      </Popconfirm>
                    </Space>
                  )}
                >
                  <div className="settings-card-content">
                    <div className="settings-card-section">
                      <div className="settings-card-label">模型列表</div>
                      <div>
                        {renderModelTags(config.enabledModels, config.channel.defaultModelId)}
                      </div>
                    </div>
                    <div className="settings-card-section">
                      <div className="settings-card-label">能力</div>
                      <div>
                        {renderCapabilityTags(config.enabledModels)}
                      </div>
                    </div>
                    <div className="settings-card-inline">
                      {config.resolvedConfig.defaultDuration && (
                        <div className="settings-card-kv">
                          <strong>{t('settings.defaultDuration')}:</strong>
                          <span>{config.resolvedConfig.defaultDuration}s</span>
                        </div>
                      )}
                      {config.resolvedConfig.defaultResolution && (
                        <div className="settings-card-kv">
                          <strong>{t('settings.defaultResolution')}:</strong>
                          <span>{config.resolvedConfig.defaultResolution}</span>
                        </div>
                      )}
                    </div>
                    {config.resolvedConfig.baseUrl && (
                      <div className="settings-card-section">
                        <div className="settings-card-label">{t('settings.apiAddress')}</div>
                        <span className="settings-card-code">
                          {config.resolvedConfig.baseUrl.replace(/https?:\/\//, '').slice(0, 36)}
                        </span>
                      </div>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}

          {pluginChannels.map((channel) => (
            <Col key={channel.id} xs={24} md={12} xl={8}>
              <Card
                size="small"
                className="settings-config-card"
                title={(
                  <Space>
                    {settings?.mediaDefaults?.itv?.channelId === channel.id ? (
                      <StarFilled className="settings-default-star" />
                    ) : (
                      <Tooltip title={t('settings.setAsDefault')}>
                        <StarOutlined
                          className="settings-default-star-button"
                          onClick={() => handleSetPluginDefault(channel)}
                        />
                      </Tooltip>
                    )}
                    <AppstoreOutlined />
                    <span>{channel.name}</span>
                    <Tag color="blue">{t('plugin.title')}</Tag>
                  </Space>
                )}
                extra={channel.pluginId ? (
                  <Tooltip title={t('settings.configSettings')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<SettingOutlined />}
                      onClick={() => openPluginModal(channel.pluginId!)}
                    />
                  </Tooltip>
                ) : null}
              >
                <div className="settings-card-content">
                  {channel.description && <div>{channel.description}</div>}
                  <div className="settings-card-inline">
                    <div className="settings-card-kv"><strong>Provider:</strong><span>{channel.providerType}</span></div>
                    {channel.defaultModelId && (
                      <div className="settings-card-kv"><strong>默认模型:</strong><span>{channel.defaultModelId}</span></div>
                    )}
                  </div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <ProviderPluginModal
        visible={pluginModalVisible}
        pluginId={activePluginId}
        onClose={closePluginModal}
        onConfigSaved={handlePluginConfigSaved}
      />

      <Modal
        title={editingChannel ? t('settings.editITVConfig') : t('settings.addITVConfig')}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={840}
        mask={{ closable: false }}
        destroyOnHidden
        className="dark-modal settings-compact-modal"
      >
        <Form form={form} layout="vertical" className="settings-modal-form">
          <div className="settings-form-section">
            <div className="settings-form-section-title">基础信息</div>
            <div className="settings-modal-grid">
              <Form.Item
                name="providerType"
                label="模型渠道"
                required={!isEditingActivationChannel}
                rules={[{ required: !isEditingActivationChannel, message: '请选择模型渠道' }]}
              >
                <Select
                  placeholder={t('settings.selectITVProvider')}
                  onChange={handleProviderChange}
                  disabled={isEditingActivationChannel}
                >
                  {channelDefinitions.map((definition) => (
                    <Select.Option key={definition.id} value={definition.id}>
                      {definition.name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item
                name="name"
                label={t('settings.configName')}
                required={!isEditingActivationChannel}
                rules={[{ required: !isEditingActivationChannel, message: `${t('settings.pleaseEnter')} ${t('settings.configName')}` }]}
              >
                <Input placeholder={t('settings.configNamePlaceholder')} disabled={isEditingActivationChannel} />
              </Form.Item>
            </div>
          </div>

          <div className="settings-form-section">
            <div className="settings-form-section-title">模型维护</div>
            <Form.Item
              label="模型列表"
              required
              className="settings-form-item-flush"
            >
              <ChannelModelsEditor
                capabilityOptions={[
                  { value: 'video.text-to-video', label: '文生视频' },
                  { value: 'video.image-to-video', label: '图生视频' },
                  { value: 'video.reference-to-video', label: '参考生视频' },
                  { value: 'video.start-end-to-video', label: '首尾帧视频' },
                ]}
                defaultCapabilities={['video.image-to-video']}
                helpText="模型列表为手动维护。请按真实能力勾选，项目会自动过滤不可用的模型。视频时长范围按模型独立配置，留空则按 provider 兜底。OpenAI 兼容渠道可在此覆盖视频任务路径。"
                modelNamePlaceholder="填写模型名称，如: viduq2-pro / gen-3 / kling-v1-5 / sora-2"
                showDurationRange
                showVideosPath={currentProviderType === 'openai-video'}
              />
            </Form.Item>
          </div>

          <div className="settings-form-section">
            <div className="settings-form-section-title">默认项与连接参数</div>
            <div className="settings-modal-grid">
              <Form.Item
                name="defaultModelId"
                label="默认模型"
                required
                rules={[{ required: true, message: '请选择默认模型' }]}
              >
                <Select
                  placeholder="选择默认模型"
                  options={modelOptions}
                />
              </Form.Item>

              <Form.Item
                name="promptProtocol"
                label="Prompt 编译协议"
                tooltip="启用后会把 @角色名 / @场景名 / @道具名 编译为 @Image N，并按渠道上限对齐参考图数量。"
              >
                <Select allowClear placeholder="不启用（默认）">
                  <Select.Option value="grok-image-index">Koma 协议</Select.Option>
                </Select>
              </Form.Item>

              {currentProviderType !== 'comfyui-animatediff' && (
                <Form.Item
                  name="apiKey"
                  label={t('settings.apiKey')}
                  rules={[{
                    required: currentProviderType !== 'comfyui-animatediff' && !editingHasStoredApiKey && !isEditingActivationChannel,
                    message: `${t('settings.pleaseEnter')} ${t('settings.apiKey')}`,
                  }]}
                >
                  <Input.Password
                    placeholder={editingHasStoredApiKey ? t('settings.apiKeyStoredPlaceholder') : t('settings.enterApiKey')}
                    disabled={isEditingActivationChannel}
                  />
                </Form.Item>
              )}

              <Form.Item
                name="baseUrl"
                label={t('settings.apiAddress')}
                rules={[{ required: !isEditingActivationChannel, message: `${t('settings.pleaseEnter')} ${t('settings.apiAddress')}` }]}
                extra={readLockedBaseUrl(currentDefinition) ? '官方渠道地址不可修改' : undefined}
              >
                <Input
                  placeholder="https://api.klingai.com"
                  disabled={isEditingActivationChannel || Boolean(readLockedBaseUrl(currentDefinition))}
                />
              </Form.Item>

              <Form.Item name="defaultDuration" label={`${t('settings.defaultDuration')} (s)`}>
                <InputNumber min={1} max={60} placeholder="5" />
              </Form.Item>

              <Form.Item name="defaultResolution" label={t('settings.defaultResolution')} className="settings-form-item-flush">
                <Select placeholder={t('settings.selectSize')} allowClear>
                  <Select.Option value="360p">360p</Select.Option>
                  <Select.Option value="720p">720p</Select.Option>
                  <Select.Option value="1080p">1080p</Select.Option>
                  <Select.Option value="1280x720">1280 × 720</Select.Option>
                  <Select.Option value="1920x1080">1920 × 1080</Select.Option>
                  <Select.Option value="720x1280">720 × 1280 ({t('settings.portrait')})</Select.Option>
                  <Select.Option value="1080x1920">1080 × 1920 ({t('settings.portrait')})</Select.Option>
                </Select>
              </Form.Item>
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  );
};
