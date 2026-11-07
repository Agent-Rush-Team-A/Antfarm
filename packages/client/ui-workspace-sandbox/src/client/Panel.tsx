/** Workspace-scoped controls; the resource provider owns observations and polling. */
import { useState } from 'react'
import { Button, IconShieldOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId, WorkspaceModeConfig } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sandboxAddress } from './address.ts'
import type { SandboxModel } from './model.ts'
import type {} from './locales.ts'
import { sandboxModeAllows } from './access.ts'
import { failureKey } from './failure-key.ts'
import css from './Panel.module.css'

/** User actions captured by the plugin; components never access services. */
export interface SandboxActions {
  /** @param workspaceId - Workspace selected by the user's entry gesture. */
  request(workspaceId: WorkspaceId): void
  /** Close the management panel without closing its sandbox. */
  dismiss(): void
  /** @param workspaceId - Workspace selected by the panel. */
  refresh: SandboxModel['refresh']
  /** @param workspaceId - Workspace selected by the panel. @param operation - Explicit user operation. */
  change(workspaceId: WorkspaceId, operation: 'open' | 'close'): void
}
/** Panel selection is a registrant-private observable, bound by the renderer. */
export interface SandboxOverlayInjected extends SandboxActions {
  hooks: { selection: SnapshotStore<WorkspaceId | null> }
}
type LauncherProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'workspaceSandbox'> & InjectFace<SandboxActions>
type OverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'workspaceSandbox'> & InjectFace<SandboxOverlayInjected>
/** The panel inherits its host's standard data and access hooks. */
export type PanelProps = Pick<OverlayProps, 'useResource' | 'useWorkspaceAccess' | 't' | 'dismiss' | 'refresh' | 'change'>
  & { workspaceId: WorkspaceId; displayTitle: string; modeConfig: WorkspaceModeConfig }

/**
 * @param props - Session identity, workspace observation and user callbacks.
 * @returns Current workspace entry when status access is allowed.
 */
export function SandboxLauncher(props: LauncherProps) {
  const workspaceId = props.useWorkspaces(snapshot =>
    snapshot.items.find(workspace => workspace.modeConfig.firstSessionId === props.sessionId
      || workspace.sessionIds.includes(props.sessionId))?.workspaceId)
  return workspaceId === undefined ? null : <WorkspaceEntry key={workspaceId} {...props} workspaceId={workspaceId} />
}

function WorkspaceEntry({ workspaceId, ...props }: LauncherProps & { workspaceId: WorkspaceId }) {
  if (!props.useWorkspaceAccess(workspaceId, 'workspaceSandbox/status')) return null
  return <Tooltip label={props.t('title')} side="top" portal>
    <Button variant="toolbar" size="sm" aria-label={props.t('title')} onClick={() => { props.request(workspaceId) }}>
      <IconShieldOutlineRegular size={18} aria-hidden />
    </Button>
  </Tooltip>
}

/**
 * @param props - Selected workspace and frame-wide dismissal.
 * @returns A panel that follows the captured workspace, independently of conversation navigation.
 */
export function SandboxOverlay(props: OverlayProps) {
  const workspaceId = props.useSelection(id => id)
  const workspace = props.useWorkspaces(snapshot => snapshot.items.find(row => row.workspaceId === workspaceId))
  return workspaceId === null || workspace === undefined ? null
    : <SandboxPanel key={workspaceId} {...props} workspaceId={workspaceId} modeConfig={workspace.modeConfig} displayTitle={workspace.title || props.t('untitled')} />
}

/** @param props - Captured workspace, resource hook, access hooks and actions. @returns Status, safe controls and close confirmation. */
export function SandboxPanel(props: PanelProps) {
  return props.useWorkspaceAccess(props.workspaceId, 'workspaceSandbox/status') ? <PanelBody {...props} /> : null
}

function PanelBody(props: PanelProps) {
  const { workspaceId, t } = props
  const resource = props.useResource<'workspacesandbox'>(sandboxAddress(workspaceId))
  const view = resource.value
  const state = view?.pending === 'open' ? 'starting' : view?.pending === 'close' ? 'closing' : view?.state
  const openAllowed = props.useWorkspaceAccess(workspaceId, 'workspaceSandbox/open')
  const closeAllowed = props.useWorkspaceAccess(workspaceId, 'workspaceSandbox/close')
  const [confirmClose, setConfirmClose] = useState(false)
  const busy = view?.pending !== undefined || state === 'starting'
  const problem = view?.failure ?? view?.statusFailure
  const unknown = problem?.outcomeUnknown === true
  const unavailable = view?.connected !== true || resource.status !== 'live' || view.statusFailure !== undefined
  const single = props.modeConfig.mode === 'single-vm' || props.modeConfig.mode === 'single-docker'
  const modeBusy = props.modeConfig.operationState !== 'ready'
  const disabled = busy || unavailable || unknown || !sandboxModeAllows(props.modeConfig, 'open')
  const stateLabel = state === undefined ? t(problem === undefined && resource.status !== 'failed' ? 'loading' : 'unconfirmed') : t(state)
  return <Modal open onClose={props.dismiss} closeLabel={t('dismiss')} title={t('title')} className={css.dialog}>
    <div className={css.panel}>
      <p className={css.workspace}>{props.displayTitle}</p>
      <div className={css.status} role="status" aria-live="polite">
        {view?.connected === false ? t('disconnectedStatus') : unknown ? t('unconfirmed')
          : view?.statusFailure !== undefined && state !== undefined ? t('staleState', { state: stateLabel }) : stateLabel}
      </div>
      <p className={css.note}>{t(single ? 'automatic' : 'retained')}</p>
      {modeBusy && <p role="alert">{t(props.modeConfig.operationState === 'recovery-required' ? 'modeRecovery' : 'modeBusy')}</p>}
      {(resource.status === 'failed' || problem !== undefined) && <p role="alert">
        {t(problem === undefined ? 'failed' : failureKey(problem))}
      </p>}
      {confirmClose && !single && state !== 'closed' ? <div className={css.confirm}>
        <p>{t('confirmNote')}</p>
        <div className={css.actions}>
          <Button variant="outline" disabled={disabled || !closeAllowed} onClick={() => {
            setConfirmClose(false); props.change(workspaceId, 'close')
          }}>{t('confirmClose')}</Button>
          <Button variant="outline" onClick={() => { setConfirmClose(false) }}>{t('cancel')}</Button>
        </div>
      </div> : <div className={css.actions}>
        {!single && state === 'closed' && <Button disabled={disabled || !openAllowed} onClick={() => { props.change(workspaceId, 'open') }}>
          {t('open')}
        </Button>}
        {!single && state !== undefined && state !== 'closed' && <Button variant="outline" disabled={disabled || !closeAllowed}
          onClick={() => { setConfirmClose(true) }}>{t(state === 'cleanup_required' ? 'cleanup' : state === 'closing' ? 'retryClose' : 'close')}</Button>}
        <Button variant="outline" disabled={busy || view?.connected !== true}
          onClick={() => { props.refresh(workspaceId) }}>{t('refresh')}</Button>
      </div>}
    </div>
  </Modal>
}
