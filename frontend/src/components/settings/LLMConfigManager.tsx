/// <reference types="vite/client" />
import React, { useCallback, useMemo } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
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
  ApiOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  LoadingOutlined,
  PlusOutlined,
  RobotOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import type { AppSettings, LLMModelConfig } from '../../types';
import { createLLMProvider } from '../../providers/llm';
import { buildLLMConfigFromContext } from '../../providers/channel/resolver';
import type { ChannelModelDefinition, ModelCapability } from '../../providers/channel/types';
import {
  generateId,
  setDefaultMediaModelSelection,
  addChannelConfig,
  updateChannelConfig,
  deleteChannelConfig,
} from '../../store/globalStore';
import { ChannelModelsEditor } from './ChannelModelsEditor';
import { useTranslation } from 'react-i18next';
import {
  buildChannelFormValues,
  buildManagedChannelCards,
  formatChannelError,
  getPreferredChannelModelId,
  listBuiltInChannelOptions,
} from './channelManagerShared';
import { useMediaConfigManager } from './useMediaConfigManager';
import {
  isKomaActivationManagedChannel,
  withKomaActivationChannelMarker,
} from '../../utils/activationManagedChannels';

interface LLMConfigManagerProps {
  onConfigChange?: () => void;
}

function getProviderColor(providerType: string) {
  switch (providerType) {
    case 'gemini': return 'blue';
    case 'claude': return 'orange';
    case 'deepseek': return 'geekblue';
    case 'qwen': return 'purple';
    case 'zhipu': return 'green';
    case 'moonshot': return 'cyan';
    default: return 'default';
  }
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

export const LLMConfigManager: React.FC<LLMConfigManagerProps> = ({ onConfigChange }) => {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const channelDefinitions = useMemo(() => listBuiltInChannelOptions('llm'), []);
  const definitionMap = useMemo(
    () => new Map(channelDefinitions.map((definition) => [definition.id, definition])),
    [channelDefinitions],
  );

  const loadBuiltins = useCallback(
    (settings: AppSettings) => buildManagedChannelCards(settings, 'llm', buildLLMConfigFromContext),
    [],
  );

  const {
    configs,
    loading,
    modalVisible,
    setModalVisible,
    editingChannel,
    setEditingChannel,
    testingId,
    setTestingId,
    form,
    settings,
    loadConfigs,
  } = useMediaConfigManager<LLMModelConfig>('llm', loadBuiltins, onConfigChange);

  const showChannelConfigCreateEntry = false;
  const watchedProviderType = Form.useWatch('providerType', form) as string | undefined;
  const isEditingActivationChannel = isKomaActivationManagedChannel(editingChannel);
  const currentProviderType = isEditingActivationChannel ? editingChannel?.providerType : watchedProviderType;
  const currentDefinition = currentProviderType ? definitionMap.get(currentProviderType) : undefined;
  const currentIsOpenAICompatible = currentDefinition?.runtimeProviderType === 'openai-compatible';
  const editingHasStoredApiKey = Boolean(editingChannel && (editingChannel.providerConfig as Record<string, unknown> | undefined)?.hasApiKey);
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

      return {
        id,
        label,
        providerModelName,
        capabilities: ['llm.chat' satisfies ModelCapability],
      };
    });
  }, []);

  const openModal = useCallback((config?: typeof configs[number]) => {
    if (config) {
      setEditingChannel(config.channel);
      form.setFieldsValue(buildChannelFormValues(config.channel, config.definition));
    } else {
      const firstDefinition = channelDefinitions[0];
      const modelId = generateId();
      setEditingChannel(null);
      form.resetFields();
      form.setFieldsValue({
        providerType: firstDefinition?.id,
        ...getChannelDefaults(firstDefinition),
        models: [{
          id: modelId,
          providerModelName: '',
          label: '',
          capabilities: ['llm.chat'],
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
    const normalizedModels = Array.isArray(existingModels) && existingModels.length > 0
      ? existingModels
      : [{
          id: generateId(),
          providerModelName: '',
          label: '',
          capabilities: ['llm.chat'],
        }];

    const currentDefaultModelId = String(form.getFieldValue('defaultModelId') || '');
    const nextDefaultModelId = currentDefaultModelId && normalizedModels.some((model: any) => String(model?.id) === currentDefaultModelId)
      ? currentDefaultModelId
      : String(normalizedModels[0]?.id || '');

    const previousName = form.getFieldValue('name');
    form.setFieldsValue({
      providerType,
      name: previousName || definition.name,
      ...getChannelDefaults(definition),
      models: normalizedModels,
      defaultModelId: nextDefaultModelId,
    });
  }, [definitionMap, form]);

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
        throw new Error('未找到对应的 LLM 渠道定义');
      }

      const models = normalizeModels(values.models);
      const modelIdSet = new Set(models.map((model) => model.id));
      const defaultModelId = modelIdSet.has(values.defaultModelId)
        ? values.defaultModelId
        : models[0]?.id;
      if (!defaultModelId) throw new Error('请至少添加一个模型');

      const providerConfig = isActivationChannel && editingChannel
        ? withKomaActivationChannelMarker({
            baseUrl: editingChannel.providerConfig?.baseUrl,
          })
        : {
            baseUrl: values.baseUrl,
            ...(String(values.apiKey || '').trim()
              ? { apiKey: String(values.apiKey).trim() }
              : {}),
          };

      const payload = {
        name: isActivationChannel && editingChannel ? editingChannel.name : values.name,
        description: definition.description,
        category: 'llm' as const,
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

      const shouldUpdateDefault =
        !settings?.mediaDefaults?.llm
        || settings.mediaDefaults.llm.channelId === (editingChannel?.id || 'PENDING_NEW_CHANNEL');
      if (shouldUpdateDefault) {
        await setDefaultMediaModelSelection('llm', { channelId: saved.id, modelId: defaultModelId });
      }

      message.success(editingChannel ? '配置已更新' : '配置已添加');
      setModalVisible(false);
      await loadConfigs();
      onConfigChange?.();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(`保存失败: ${formatChannelError(err, t)}`);
    }
  }, [definitionMap, editingChannel, form, loadConfigs, message, onConfigChange, setModalVisible, settings?.mediaDefaults?.llm]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteChannelConfig(id);
      message.success('配置已删除');
      await loadConfigs();
      onConfigChange?.();
    } catch (err: any) {
      message.error(`删除失败: ${formatChannelError(err, t)}`);
    }
  }, [loadConfigs, message, onConfigChange]);

  const handleSetDefault = useCallback(async (channelId: string, modelId?: string) => {
    if (!modelId) {
      message.error('当前渠道没有可用模型');
      return;
    }

    try {
      await setDefaultMediaModelSelection('llm', { channelId, modelId });
      message.success('已设为默认');
      await loadConfigs();
      onConfigChange?.();
    } catch (err: any) {
      message.error(`设置失败: ${err?.message || String(err)}`);
    }
  }, [loadConfigs, message, onConfigChange]);

  const handleTestConnection = useCallback(async (config: typeof configs[number]) => {
    setTestingId(config.channel.id);
    try {
      const provider = createLLMProvider({
        provider: config.resolvedConfig.provider,
        profileId: config.channel.id,
        hasStoredCredential: config.resolvedConfig.hasStoredCredential,
        apiKey: config.resolvedConfig.apiKey,
        baseUrl: config.resolvedConfig.baseUrl,
        modelName: config.resolvedConfig.modelName,
      });
      if (!provider.validate()) {
        throw new Error('配置校验失败');
      }
      const success = await provider.testConnection();
      if (success) {
        message.success(`"${config.channel.name}" 连接成功`);
      } else {
        message.error(`"${config.channel.name}" 连接失败，请检查配置`);
      }
    } catch (err: any) {
      message.error(`连接测试失败: ${formatChannelError(err, t)}`);
    } finally {
      setTestingId(null);
    }
  }, [message, setTestingId]);

  const renderModelTags = useCallback((models: ChannelModelDefinition[], defaultModelId?: string) => (
    <Space wrap size={[6, 6]}>
      {models.map((model) => (
        <Tag key={model.id} color={model.id === defaultModelId ? 'gold' : 'default'}>
          {model.label}
        </Tag>
      ))}
    </Space>
  ), []);

  return (
    <div className="settings-manager">
      <div className="settings-manager-toolbar">
        <div className="settings-toolbar-meta">
          <span>
            已配置 <strong>{configs.length}</strong> 个渠道
          </span>
        </div>
        {showChannelConfigCreateEntry && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
            添加渠道
          </Button>
        )}
      </div>

      {loading ? (
        <div className="settings-loading-state">
          <Spin />
        </div>
      ) : configs.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有配置任何 LLM 渠道"
          className="settings-empty-state"
        >
          {showChannelConfigCreateEntry && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
              添加第一个渠道
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
                        <Tooltip title="设为默认">
                          <StarOutlined
                            className="settings-default-star-button"
                            onClick={() => handleSetDefault(config.channel.id, preferredModelId)}
                          />
                        </Tooltip>
                      )}
                      <RobotOutlined />
                      <span>{config.channel.name}</span>
                      <Tag color={getProviderColor(config.definition.id)}>{config.definition.name}</Tag>
                    </Space>
                  )}
                  extra={(
                    <Space size="small">
                      <Tooltip title="测试连接">
                        <Button
                          type="text"
                          size="small"
                          icon={testingId === config.channel.id ? <LoadingOutlined /> : <CheckCircleOutlined />}
                          onClick={() => handleTestConnection(config)}
                          disabled={testingId === config.channel.id}
                        />
                      </Tooltip>
                      <Tooltip title="编辑">
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => openModal(config)}
                        />
                      </Tooltip>
                      <Popconfirm
                        title="确定删除此配置？"
                        onConfirm={() => handleDelete(config.channel.id)}
                        okText="删除"
                        cancelText="取消"
                      >
                        <Tooltip title="删除">
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
                    {config.resolvedConfig.baseUrl && (
                      <div className="settings-card-section">
                        <div className="settings-card-label">地址</div>
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
        </Row>
      )}

      <Modal
        title={editingChannel ? '编辑渠道配置' : '添加渠道配置'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={760}
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
                <Select onChange={handleProviderChange} disabled={isEditingActivationChannel}>
                  {channelDefinitions.map((definition) => (
                    <Select.Option key={definition.id} value={definition.id}>
                      {definition.name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item
                name="name"
                label="配置名称"
                required={!isEditingActivationChannel}
                rules={[{ required: !isEditingActivationChannel, message: '请输入配置名称' }]}
              >
                <Input placeholder="如: DeepSeek 团队账号" disabled={isEditingActivationChannel} />
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
                fixedCapabilities={['llm.chat']}
                helpText="模型列表为手动维护。修改模型名称不会影响项目中的已选择项，系统会继续按稳定 ID 关联。"
              />
            </Form.Item>
          </div>

          <div className="settings-form-section">
            <div className="settings-form-section-title">连接参数</div>
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
                name="baseUrl"
                label={(
                  <span>
                    API 地址
                    {!currentIsOpenAICompatible && <span className="settings-title-optional">(可选，用于代理)</span>}
                  </span>
                )}
                rules={[{ required: currentIsOpenAICompatible && !isEditingActivationChannel, message: '请输入 API 地址' }]}
              >
                <Input
                  prefix={<ApiOutlined />}
                  placeholder={currentIsOpenAICompatible ? 'https://api.deepseek.com/v1' : '可留空使用官方地址'}
                  disabled={isEditingActivationChannel}
                />
              </Form.Item>

              <Form.Item
                name="apiKey"
                label="API Key"
                className="settings-grid-span-full settings-form-item-flush"
                required={!editingHasStoredApiKey && !isEditingActivationChannel}
                rules={[{ required: !editingHasStoredApiKey && !isEditingActivationChannel, message: '请输入 API Key' }]}
              >
                <Input.Password
                  prefix={<KeyOutlined />}
                  placeholder={editingHasStoredApiKey ? '留空则保持现有 Key' : 'sk-...'}
                  disabled={isEditingActivationChannel}
                />
              </Form.Item>
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  );
};
