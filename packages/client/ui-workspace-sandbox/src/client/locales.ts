/** Typed, locale-owned sandbox controls and progress labels. */
export const en = {
  title: 'Workspace sandbox',
  dismiss: 'Close panel',
  loading: 'Checking status…',
  closed: 'Closed',
  starting: 'Starting…',
  running: 'Running',
  closing: 'Closing…',
  cleanup_required: 'Cleanup required',
  retained: 'Closing retains workspace files and conversations.',
  open: 'Open sandbox',
  close: 'Close sandbox',
  refresh: 'Refresh status',
  confirmNote: 'Closing stops active and queued tasks in this workspace. Files will be retained.',
  confirmClose: 'Confirm close',
  cancel: 'Cancel',
  failed: 'The request failed. Refresh status before trying again.',
  opened: 'Sandbox opened',
  closedNotice: 'Sandbox closed',
}

/** Chinese sandbox controls and recovery guidance. */
export const zh: Record<keyof typeof en, string> = {
  title: '工作区沙箱',
  dismiss: '关闭面板',
  loading: '正在查询状态…',
  closed: '已关闭',
  starting: '正在开启…',
  running: '运行中',
  closing: '正在关闭…',
  cleanup_required: '需要清理',
  retained: '关闭沙箱后，工作区文件和对话会保留',
  open: '开启沙箱',
  close: '关闭沙箱',
  refresh: '刷新状态',
  confirmNote: '关闭沙箱会终止当前工作区正在处理和等待的任务，文件会保留',
  confirmClose: '确认关闭',
  cancel: '取消',
  failed: '请求失败，请刷新状态后重试',
  opened: '沙箱已开启',
  closedNotice: '沙箱已关闭',
}

/** Japanese sandbox controls and recovery guidance. */
export const ja: Record<keyof typeof en, string> = {
  title: 'ワークスペースのサンドボックス',
  dismiss: 'パネルを閉じる',
  loading: '状態を確認中…',
  closed: '停止済み',
  starting: '起動中…',
  running: '実行中',
  closing: '停止中…',
  cleanup_required: 'クリーンアップが必要',
  retained: '停止してもワークスペースのファイルと会話は保持されます。',
  open: 'サンドボックスを起動',
  close: 'サンドボックスを停止',
  refresh: '状態を更新',
  confirmNote: '停止すると、このワークスペースで実行中および待機中のタスクが終了します。ファイルは保持されます。',
  confirmClose: '停止を確認',
  cancel: 'キャンセル',
  failed: 'リクエストに失敗しました。状態を更新してから再試行してください。',
  opened: 'サンドボックスを起動しました',
  closedNotice: 'サンドボックスを停止しました',
}

/** German sandbox controls and recovery guidance. */
export const de: Record<keyof typeof en, string> = {
  title: 'Workspace-Sandbox',
  dismiss: 'Panel schließen',
  loading: 'Status wird geprüft…',
  closed: 'Geschlossen',
  starting: 'Startet…',
  running: 'Läuft',
  closing: 'Wird geschlossen…',
  cleanup_required: 'Bereinigung erforderlich',
  retained: 'Dateien und Unterhaltungen im Workspace bleiben beim Schließen erhalten.',
  open: 'Sandbox öffnen',
  close: 'Sandbox schließen',
  refresh: 'Status aktualisieren',
  confirmNote: 'Schließen beendet aktive und wartende Aufgaben in diesem Workspace. Dateien bleiben erhalten.',
  confirmClose: 'Schließen bestätigen',
  cancel: 'Abbrechen',
  failed: 'Die Anfrage ist fehlgeschlagen. Aktualisieren Sie den Status vor einem erneuten Versuch.',
  opened: 'Sandbox geöffnet',
  closedNotice: 'Sandbox geschlossen',
}

/** French sandbox controls and recovery guidance. */
export const fr: Record<keyof typeof en, string> = {
  title: 'Bac à sable de l’espace de travail',
  dismiss: 'Fermer le panneau',
  loading: 'Vérification de l’état…',
  closed: 'Fermé',
  starting: 'Démarrage…',
  running: 'En cours',
  closing: 'Fermeture…',
  cleanup_required: 'Nettoyage requis',
  retained: 'La fermeture conserve les fichiers et les conversations de l’espace de travail.',
  open: 'Ouvrir le bac à sable',
  close: 'Fermer le bac à sable',
  refresh: 'Actualiser l’état',
  confirmNote: 'La fermeture arrête les tâches actives et en attente de cet espace de travail. Les fichiers seront conservés.',
  confirmClose: 'Confirmer la fermeture',
  cancel: 'Annuler',
  failed: 'La requête a échoué. Actualisez l’état avant de réessayer.',
  opened: 'Bac à sable ouvert',
  closedNotice: 'Bac à sable fermé',
}

/** Spanish sandbox controls and recovery guidance. */
export const es: Record<keyof typeof en, string> = {
  title: 'Entorno aislado del espacio de trabajo',
  dismiss: 'Cerrar panel',
  loading: 'Consultando estado…',
  closed: 'Cerrado',
  starting: 'Iniciando…',
  running: 'En ejecución',
  closing: 'Cerrando…',
  cleanup_required: 'Requiere limpieza',
  retained: 'Al cerrar se conservan los archivos y las conversaciones del espacio de trabajo.',
  open: 'Abrir entorno aislado',
  close: 'Cerrar entorno aislado',
  refresh: 'Actualizar estado',
  confirmNote: 'El cierre detiene las tareas activas y en espera de este espacio de trabajo. Se conservarán los archivos.',
  confirmClose: 'Confirmar cierre',
  cancel: 'Cancelar',
  failed: 'La solicitud falló. Actualiza el estado antes de volver a intentarlo.',
  opened: 'Entorno aislado abierto',
  closedNotice: 'Entorno aislado cerrado',
}

/** Portuguese sandbox controls and recovery guidance. */
export const pt: Record<keyof typeof en, string> = {
  title: 'Sandbox do espaço de trabalho',
  dismiss: 'Fechar painel',
  loading: 'Consultando estado…',
  closed: 'Fechado',
  starting: 'Iniciando…',
  running: 'Em execução',
  closing: 'Fechando…',
  cleanup_required: 'Limpeza necessária',
  retained: 'O fechamento mantém os arquivos e as conversas do espaço de trabalho.',
  open: 'Abrir sandbox',
  close: 'Fechar sandbox',
  refresh: 'Atualizar estado',
  confirmNote: 'O fechamento interrompe as tarefas ativas e em espera neste espaço de trabalho. Os arquivos serão mantidos.',
  confirmClose: 'Confirmar fechamento',
  cancel: 'Cancelar',
  failed: 'A solicitação falhou. Atualize o estado antes de tentar novamente.',
  opened: 'Sandbox aberto',
  closedNotice: 'Sandbox fechado',
}

/** Russian sandbox controls and recovery guidance. */
export const ru: Record<keyof typeof en, string> = {
  title: 'Песочница рабочего пространства',
  dismiss: 'Закрыть панель',
  loading: 'Проверка состояния…',
  closed: 'Закрыта',
  starting: 'Запуск…',
  running: 'Работает',
  closing: 'Закрытие…',
  cleanup_required: 'Требуется очистка',
  retained: 'При закрытии файлы и диалоги рабочего пространства сохраняются.',
  open: 'Открыть песочницу',
  close: 'Закрыть песочницу',
  refresh: 'Обновить состояние',
  confirmNote: 'Закрытие остановит активные и ожидающие задачи в этом рабочем пространстве. Файлы сохранятся.',
  confirmClose: 'Подтвердить закрытие',
  cancel: 'Отмена',
  failed: 'Запрос не выполнен. Обновите состояние перед повторной попыткой.',
  opened: 'Песочница открыта',
  closedNotice: 'Песочница закрыта',
}

/** Localized sandbox dictionary keys. */
export type SandboxCopyKey = keyof typeof en

/** Complete dictionaries for every shipped UI language. */
export const dictionaries = { en, zh, ja, de, fr, es, pt, ru }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Workspace sandbox control copy. */ workspaceSandbox: SandboxCopyKey }
}
