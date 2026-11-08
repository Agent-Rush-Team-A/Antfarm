/** Localized boot copy available before the locale plugin activates. */
export interface BootCopy {
  readonly brand: string
  readonly loading: string
  readonly progress: string
  readonly failed: string
}

const en: BootCopy = {
  brand: 'Antfarm',
  loading: 'Preparing Antfarm…',
  progress: 'Loading Antfarm',
  failed: 'Antfarm could not start',
}
const zh: BootCopy = {
  brand: 'Antfarm',
  loading: '正在准备 Antfarm…',
  progress: 'Antfarm 加载进度',
  failed: 'Antfarm 未能启动',
}

/** @param language - Document language. @returns Boot copy without loading a client plugin. */
export function bootCopy(language: string): BootCopy {
  return language.toLowerCase().startsWith('zh') ? zh : en
}
