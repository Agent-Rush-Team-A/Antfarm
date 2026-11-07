/** Locale-owned copy for the personal-credential form. */
export const en = {
  title: 'My credentials', description: 'Credentials belong to your account. Sharing a workspace does not share them.',
  close: 'Close', empty: 'No credentials saved.', loading: 'Loading credentials…',
  name: 'Name', value: 'Credential value', save: 'Save credential', replace: 'Replace value',
  namePlaceholder: 'For example: Vultr API Key',
  nameHint: 'Use the credential name required by your service, such as Vultr API Key.',
  valuePlaceholder: 'Paste the API key or access token from your provider',
  valueHint: 'Enter only the secret itself. For Vultr, the key must have Cloud Inference access; cloud management access alone is not enough.',
  usageNote: 'Save Vultr inference credentials as Vultr API Key to load available models automatically, then choose a model in the conversation. Calls use only your own credential.',
  saving: 'Saving credential and loading available models…', modelsLoading: 'Loading available models…',
  modelsLoaded: '{count} models available. Choose a model in the conversation.',
  modelsStale: 'Could not refresh models; the previous {count} models remain available. Retry loading models.',
  modelsFailed: 'Credential saved, but models could not be loaded. Retry loading models.',
  modelsRefresh: 'Refresh models', modelsRetry: 'Retry loading models',
  cancel: 'Cancel', saved: 'Saved', check: 'Check storage', checked: 'The saved credential can be read by the server.',
  checkNote: 'Storage checks do not validate access to an external service.',
  remove: 'Delete', confirmRemove: 'Confirm deletion', removed: 'Credential deleted.', refresh: 'Refresh',
  failed: 'The request did not finish. Refresh the list before trying again.', unavailable: 'Credential storage is unavailable. Contact the administrator.',
  invalid: 'Enter a name and a valid credential value within the configured size limit.',
  limit: 'Your account has reached its credential limit.', notFound: 'This credential is no longer available.',
  unauthorized: 'Your login is no longer active. Sign in again.',
}

/** Personal-credential dictionary keys. */
export type CredentialCopyKey = keyof typeof en

/** Chinese dictionary for personal credentials. */
export const zh: Record<CredentialCopyKey, string> = {
  title: '我的凭证', description: '凭证属于你的账号，共享工作区不会共享凭证。',
  close: '关闭', empty: '尚未保存凭证。', loading: '正在加载凭证…',
  name: '名称', value: '凭证值', save: '保存凭证', replace: '替换凭证值',
  namePlaceholder: '例如：Vultr API Key',
  nameHint: '按服务要求填写凭证名称，例如 Vultr API Key。',
  valuePlaceholder: '粘贴服务商提供的 API Key 或访问令牌',
  valueHint: '只填写密钥本身。Vultr 密钥必须有 Cloud Inference 访问权限；能管理云实例不代表能调用模型。',
  usageNote: 'Vultr 推理凭证请命名为 Vultr API Key，保存后自动加载可用模型，再到对话中选择模型。调用时只使用你自己的凭证。',
  saving: '正在保存凭证并加载可用模型…', modelsLoading: '正在加载可用模型…',
  modelsLoaded: '已有 {count} 个可选模型，请到对话中选择',
  modelsStale: '模型刷新失败，保留上次的 {count} 个模型，请重试加载',
  modelsFailed: '凭证已保存，但模型加载失败，请重试加载',
  modelsRefresh: '刷新模型', modelsRetry: '重试加载模型',
  cancel: '取消', saved: '已保存', check: '检查保存状态', checked: '后端可以正确读取已保存的凭证',
  checkNote: '保存检查不会验证外部服务的访问权限。',
  remove: '删除', confirmRemove: '确认删除', removed: '凭证已删除', refresh: '刷新',
  failed: '请求未完成，请先刷新列表再重试', unavailable: '凭证存储不可用，请联系管理员',
  invalid: '请填写名称和有效凭证值，并确保未超过配置的大小限制',
  limit: '你的账号已达到凭证数量上限', notFound: '此凭证已不可用',
  unauthorized: '登录状态已失效，请重新登录',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Personal-credential management copy. */
    'userCredentials': CredentialCopyKey
  }
}
