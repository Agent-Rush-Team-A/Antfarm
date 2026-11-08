/** Persistent environment status contributed to the workspace file panel. */
import { Button, IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SandboxActions } from './Panel.tsx'
import { sandboxAddress } from './address.ts'
import css from './InlineEnvironment.module.css'

type Props = PropsRuntime<'workspace.files.environment'> & PropsLocale<'workspaceSandbox'> & InjectFace<SandboxActions>

/** @param props - Current Workspace identity and existing environment controls. @returns Live status with retention guidance. */
export function InlineEnvironment(props: Props) {
  const resource = props.useResource<'workspacesandbox'>(sandboxAddress(props.workspaceId))
  const value = resource.value
  const state = value?.pending === 'open' ? 'starting' : value?.pending === 'close' ? 'closing' : value?.state
  const available = resource.status === 'live' && value?.connected === true && value.statusFailure === undefined
  const label = !available ? props.t('unconfirmed') : props.t(state ?? 'loading')
  const single = props.mode.startsWith('single-')
  return <section className={css.panel}>
    <div className={css.heading}><IconShieldOutlineRegular size={17} /><span>{props.t('title')}</span><Button variant="ghost" size="sm" onClick={() => { props.refresh(props.workspaceId) }}>{props.t('refresh')}</Button></div>
    <p role="status"><span className={css.dot} data-running={available && state === 'running' || undefined} />{label}</p>
    <small>{props.t(single ? 'automatic' : 'retained')}</small>
  </section>
}
