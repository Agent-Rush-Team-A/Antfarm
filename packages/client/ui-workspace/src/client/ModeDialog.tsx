/** Workspace configuration form over the existing Workspace projection. */
import clsx from 'clsx'
import type { WorkspaceMode } from '@deepseek-ai/dsh-workspace/types'
import { useState } from 'react'
import { Button, IconQuestionOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceKey } from './locales.ts'
import css from './ModeDialog.module.css'

/** One captured configuration gesture; callbacks stay with the registration owner. */
export interface ModeSelection {
  readonly workspaceId: WorkspaceId
  readonly startsSession: boolean
  readonly availableModes?: readonly WorkspaceMode[]
  readonly queryFailure?: WorkspaceKey
  readonly saveFailure?: WorkspaceKey
}

/** Configuration actions and private interaction sources bound by the renderer. */
export interface ModeDialogInjected {
  hooks: {
    modeSelection: SnapshotStore<ModeSelection | null>
    modePending: SnapshotStore<readonly WorkspaceId[]>
  }
  dismissMode(): void
  refreshMode(workspaceId: WorkspaceId): void
  /** Resolve true when the draft can be discarded in favor of the committed mode. */
  saveMode(workspaceId: WorkspaceId, mode: WorkspaceMode, revision: number): Promise<boolean>
  beginModeSession(): void
}

type Props = PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'> & InjectFace<ModeDialogInjected>
/** @param props - Framework hooks and captured actions. @returns The selected Workspace form. */
export function ModeOverlay(props: Props) {
  const selection = props.useModeSelection(value => value)
  const row = props.useWorkspaces(value => value.items.find(item => item.workspaceId === selection?.workspaceId))
  const pending = props.useModePending(ids => selection !== null && ids.includes(selection.workspaceId))
  return selection === null || row === undefined ? null
    : <ModeForm key={selection.workspaceId} {...props} row={row} selection={selection} pending={pending} />
}

const modes: readonly WorkspaceMode[] = ['single-vm', 'multi-vm', 'single-docker', 'multi-docker']
const helpSections = ['sessions', 'runs', 'benefit', 'fit'] as const
/** Pure form props shared with focused presentation tests. */
export type ModeFormProps = Pick<Props, 't' | 'useWorkspaceAccess' | 'dismissMode' | 'refreshMode' | 'saveMode' | 'beginModeSession'>
  & { row: WorkspaceView; selection: ModeSelection; pending: boolean }

/** @param props - Live row and local interaction callbacks. @returns Revision-checked mode choices and permanent locking. */
export function ModeForm(props: ModeFormProps) {
  const { row, selection, pending, t } = props
  const config = row.modeConfig
  const readAllowed = props.useWorkspaceAccess(row.workspaceId, 'workspace/getMode')
  const editAllowed = props.useWorkspaceAccess(row.workspaceId, 'workspace/setMode')
  const createAllowed = props.useWorkspaceAccess(row.workspaceId, 'session/create')
  const [draft, setDraft] = useState<{ mode: WorkspaceMode; revision: number } | null>(null)
  const availableModes = selection.availableModes ?? []
  const visibleModes = modes.filter(mode => availableModes.includes(mode) || mode === config.mode)
  const defaultSingleVm = config.revision === 0 && !config.modeLocked && editAllowed
    && selection.saveFailure === undefined && availableModes.includes('single-vm')
  const selected = draft?.mode ?? (defaultSingleVm ? 'single-vm' : config.mode)
  const stale = draft !== null && draft.revision !== config.revision
  const busy = pending || config.operationState !== 'ready' || (selection.availableModes === undefined && selection.queryFailure === undefined)
  const disabled = busy || config.modeLocked || !editAllowed || selection.queryFailure !== undefined
  const problem = selection.saveFailure ?? selection.queryFailure ?? (stale && !pending ? 'mode.conflict'
    : !config.modeLocked && selection.availableModes?.length === 0 ? 'mode.runtime' : undefined)
  if (!readAllowed) return null
  return <Modal open title={t('mode.title')} closeLabel={t('close')} onClose={props.dismissMode} className={clsx(css.dialog)}>
    <div className={css.body}>
      <p className={css.workspace}>{row.title}</p>
      <p role="status" aria-live="polite">{t(`mode.${config.operationState}`)}</p>
      <p>{t(config.modeLocked ? 'mode.locked' : 'mode.unlocked')}</p>
      {config.modeLocked && config.firstSessionId !== null && <code className={css.identity}>{config.firstSessionId}</code>}
      <fieldset className={css.choices}>
        <legend>{t('mode.choose')}</legend>
        {visibleModes.map((mode) => {
          const label = t(`mode.${mode}`)
          return <div key={mode} className={css.option}>
            <label className={css.choice}>
              <input type="radio" name={`workspace-mode-${row.workspaceId}`} value={mode} checked={selected === mode} disabled={disabled || !availableModes.includes(mode)}
                onChange={() => { setDraft({ mode, revision: config.revision }) }} />
              <span>{defaultSingleVm && mode === 'single-vm' ? t('mode.defaultOption', { mode: label }) : label}</span>
            </label>
            <Tooltip label={() => <span className={css.helpDetails} role="list">
              {helpSections.map(section => <span key={section} role="listitem">
                <strong>{t(`mode.help.${section}`)}</strong>{' '}{t(`mode.help.${mode}.${section}`)}
              </span>)}
            </span>} delayMs={300} maxWidth={360} portal openOnClick>
              <Button size="sm" className={css.help} aria-label={t('mode.help.label', { mode: label })}>
                <IconQuestionOutlineRegular aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        })}
      </fieldset>
      {problem !== undefined && <p role="alert">{t(problem)}</p>}
      <div className={css.actions}>
        {!config.modeLocked && <Button disabled={disabled || stale || selected === config.mode || !availableModes.includes(selected)}
          onClick={() => {
            void props.saveMode(row.workspaceId, selected, draft?.revision ?? config.revision)
              .then((saved) => { if (saved) setDraft(null) })
          }}>
          {t('mode.save')}
        </Button>}
        <Button variant="outline" disabled={pending}
          onClick={() => { setDraft(null); props.refreshMode(row.workspaceId) }}>{t('mode.refresh')}</Button>
        {selection.startsSession && <Button
          disabled={busy || stale || selected !== config.mode || !createAllowed || selection.queryFailure !== undefined}
          onClick={props.beginModeSession}>{t('mode.begin')}</Button>}
      </div>
    </div>
  </Modal>
}
