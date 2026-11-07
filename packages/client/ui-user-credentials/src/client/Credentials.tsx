/** Caller-owned credential form; submitted secrets never enter shared client state. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, IconShieldOutlineRegular, Input, Modal, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CreateCredentialRequest, ReplaceCredentialRequest, CredentialModelCatalogResult, UserCredentialId, UserCredentialView } from '@deepseek-ai/dsh-api-user-credentials/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CredentialCopyKey } from './locales.ts'
import css from './Credentials.module.css'

/** Plain callbacks and connection observation supplied by the registrant. */
export interface CredentialActions {
  /** @param id - own record. @param force - explicit retry. @param signal - dialog lifetime. @returns public directory status. */
  refreshModels: (id: UserCredentialId, force: boolean, signal: AbortSignal) => Promise<CredentialModelCatalogResult>
  /** @param signal - dialog lifetime. @returns caller-owned safe metadata. */
  list: (signal: AbortSignal) => Promise<UserCredentialView[]>
  /** @param request - submitted form. @param signal - dialog lifetime. @returns committed metadata. */
  create: (request: CreateCredentialRequest, signal: AbortSignal) => Promise<UserCredentialView>
  /** @param request - own record and new secret. @param signal - dialog lifetime. @returns committed metadata. */
  replace: (request: ReplaceCredentialRequest, signal: AbortSignal) => Promise<UserCredentialView>
  /** @param id - own record. @param signal - dialog lifetime. @returns durable confirmation. */
  remove: (id: UserCredentialId, signal: AbortSignal) => Promise<void>
  /** @param id - own record. @param signal - dialog lifetime. @returns storage readability only. */
  check: (id: UserCredentialId, signal: AbortSignal) => Promise<void>
}

/** Registration face; the renderer supplies the connection hook. */
export interface CredentialsInjected extends CredentialActions {
  hooks: { connection: {
    getSnapshot(): ConnectionState | undefined
    subscribe(listener: () => void): () => void
  } }
}

/** Sidebar footer action props assembled by the slot framework. */
export type CredentialsLauncherProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'userCredentials'> & InjectFace<CredentialsInjected>

/** @param props - footer geometry, locale and private callbacks. @returns entry and its private dialog. */
export function CredentialsLauncher(props: CredentialsLauncherProps) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState<{ sequence: number; copy: CredentialCopyKey; success: boolean }>()
  const sequence = useRef(0)
  const connected = props.useConnection(state => state) === 'connected'
  useEffect(() => { if (!connected) { setOpen(false); setFeedback(undefined) } }, [connected])
  return <>
    <Tooltip label={props.t('title')} disabled={props.wide} portal>
      <Button className={css.launcher} aria-label={props.t('title')} disabled={!connected} onClick={() => { setOpen(true) }}>
        <IconShieldOutlineRegular aria-hidden />{props.wide && <span>{props.t('title')}</span>}
      </Button>
    </Tooltip>
    {feedback !== undefined && connected && <Toast key={feedback.sequence} text={props.t(feedback.copy)}
      {...feedback.success ? { tone: 'success' as const } : {}} onDone={() => { setFeedback(undefined) }} />}
    {open && connected && <CredentialsPanel {...props} report={(copy, success) => {
      setFeedback({ sequence: ++sequence.current, copy, success })
    }} onClose={() => { setOpen(false) }} />}
  </>
}

function failureKey(error: unknown): CredentialCopyKey {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  switch (code) {
    case 'user-credentials/unauthorized': case 'gateway/cancelled': return 'unauthorized'
    case 'user-credentials/not-found': return 'notFound'
    case 'user-credentials/invalid-request': return 'invalid'
    case 'user-credentials/limit': return 'limit'
    case 'user-credentials/unavailable': return 'unavailable'
    default: return 'failed'
  }
}

function isActive(controller: AbortController): boolean { return !controller.signal.aborted }

/**
 * Private dialog state is discarded on close, disconnect or account replacement.
 * @param props - caller-owned callbacks, typed translations and dismissal.
 * @returns a form that clears its password input before sending each write.
 */
export function CredentialsPanel(props: CredentialActions & { t: TranslateNS<'userCredentials'>; onClose: () => void; report: (copy: CredentialCopyKey, success: boolean) => void }) {
  const [rows, setRows] = useState<UserCredentialView[]>([])
  const [busy, setBusy] = useState(true)
  const [editing, setEditing] = useState<UserCredentialView | undefined>()
  const [confirmRemove, setConfirmRemove] = useState<UserCredentialId | undefined>()
  const [error, setError] = useState<CredentialCopyKey | undefined>()
  const [activity, setActivity] = useState<'credentials' | 'saving' | 'models'>('credentials')
  const [catalogs, setCatalogs] = useState<Partial<Record<UserCredentialId, CredentialModelCatalogResult>>>({})
  const name = useRef<HTMLInputElement>(null)
  const secret = useRef<HTMLInputElement>(null)
  const lifetime = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const nameId = useId()
  const secretId = useId()
  const nameHintId = useId()
  const secretHintId = useId()
  const { list, refreshModels } = props

  async function loadModels(id: UserCredentialId, force: boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    setActivity('models')
    let result: CredentialModelCatalogResult
    try { result = await refreshModels(id, force, signal) }
    catch (_error) { result = { status: 'failed', modelCount: 0 } }
    const controller = lifetime.current
    if (controller !== null && isActive(controller) && controller.signal === signal) {
      setCatalogs(current => ({ ...current, [id]: result }))
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    pending.current = true
    void list(controller.signal).then(async (value) => {
      if (!isActive(controller)) return
      setRows(value)
      await Promise.all(value.map(row => loadModels(row.id, false, controller.signal)))
    }).catch((failure: unknown) => {
      if (isActive(controller)) setError(failureKey(failure))
    }).finally(() => {
      if (isActive(controller)) { pending.current = false; setBusy(false) }
    })
    return () => { controller.abort(); if (secret.current !== null) secret.current.value = '' }
  }, [list, refreshModels])

  async function run(operation: (signal: AbortSignal) => Promise<unknown>, success?: CredentialCopyKey): Promise<void> {
    const controller = lifetime.current
    if (controller === null || !isActive(controller) || pending.current) return
    pending.current = true
    setBusy(true); setError(undefined); setActivity('credentials')
    try {
      await operation(controller.signal)
      if (!isActive(controller)) return
      if (success !== undefined) props.report(success, true)
      const current = await props.list(controller.signal)
      if (isActive(controller)) setRows(current)
    } catch (failure) {
      if (isActive(controller)) { setError(failureKey(failure)); props.report(failureKey(failure), false) }
    } finally {
      if (isActive(controller)) { pending.current = false; setBusy(false) }
    }
  }

  const cancelEdit = (): void => {
    setEditing(undefined)
    if (name.current !== null) name.current.value = ''
    if (secret.current !== null) secret.current.value = ''
  }

  return <Modal open title={props.t('title')} closeLabel={props.t('close')} description={props.t('description')}
    onClose={props.onClose} className={css.dialog} contentClassName={css.content}>
    <div className={css.body}>
      {error !== undefined && <p role="alert">{props.t(error)}</p>}
      <form className={css.form} onSubmit={(event) => {
        event.preventDefault()
        if (pending.current || secret.current === null || name.current === null) return
        const value = secret.current.value
        const label = name.current.value
        secret.current.value = ''
        void run(async (signal) => {
          setActivity('saving')
          const record = editing === undefined ? await props.create({ name: label, value }, signal)
            : await props.replace({ id: editing.id, value }, signal)
          if (signal.aborted) return
          cancelEdit()
          setRows(current => [...current.filter(row => row.id !== record.id), record])
          await loadModels(record.id, false, signal)
        }, 'saved')
      }}>
        <label htmlFor={nameId}>{props.t('name')}</label>
        <Input id={nameId} ref={name} maxLength={128} required disabled={busy || editing !== undefined} data-modal-autofocus
          placeholder={props.t('namePlaceholder')} aria-describedby={nameHintId} />
        <p id={nameHintId} className={css.note}>{props.t('nameHint')}</p>
        <label htmlFor={secretId}>{props.t('value')}</label>
        <Input id={secretId} ref={secret} type="password" autoComplete="off" required disabled={busy}
          placeholder={props.t('valuePlaceholder')} aria-describedby={secretHintId} />
        <p id={secretHintId} className={css.note}>{props.t('valueHint')}</p>
        <div className={css.actions}>
          <Button type="submit" variant="primary" disabled={busy}>{props.t(editing === undefined ? 'save' : 'replace')}</Button>
          {editing !== undefined && <Button disabled={busy} onClick={cancelEdit}>{props.t('cancel')}</Button>}
        </div>
      </form>
      <p className={css.note}>{props.t('usageNote')}</p>
      <p className={css.note}>{props.t('checkNote')}</p>
      <Button disabled={busy} onClick={() => { void run(async () => {}) }}>{props.t('refresh')}</Button>
      {busy && <p role="status">{props.t(activity === 'saving' ? 'saving' : activity === 'models' ? 'modelsLoading' : 'loading')}</p>}
      {!busy && error === undefined && rows.length === 0 && <p>{props.t('empty')}</p>}
      <ul className={css.list}>
        {rows.map(row => <li key={row.id} className={css.row}>
          <div><strong>{row.name}</strong><span className={css.status}>{props.t('saved')}</span></div>
          {catalogs[row.id]?.status === 'ready' && <p className={css.note} role="status">
            {props.t('modelsLoaded', { count: catalogs[row.id]?.modelCount ?? 0 })}
          </p>}
          {catalogs[row.id]?.status === 'stale' && <p className={css.note} role="alert">
            {props.t('modelsStale', { count: catalogs[row.id]?.modelCount ?? 0 })}
          </p>}
          {catalogs[row.id]?.status === 'failed' && <p className={css.note} role="alert">{props.t('modelsFailed')}</p>}
          <div className={css.actions}>
            {catalogs[row.id]?.status !== 'unsupported' && <Button size="sm" disabled={busy} onClick={() => {
              void run(signal => loadModels(row.id, true, signal))
            }}>{props.t(catalogs[row.id]?.status === 'failed' || catalogs[row.id]?.status === 'stale' ? 'modelsRetry' : 'modelsRefresh')}</Button>}
            <Button size="sm" disabled={busy} onClick={() => { void run(signal => props.check(row.id, signal), 'checked') }}>{props.t('check')}</Button>
            <Button size="sm" disabled={busy} onClick={() => {
              setEditing(row); setConfirmRemove(undefined)
              if (name.current !== null) name.current.value = row.name
              if (secret.current !== null) { secret.current.value = ''; secret.current.focus() }
            }}>{props.t('replace')}</Button>
            <Button size="sm" disabled={busy} onClick={() => {
              if (confirmRemove !== row.id) { setConfirmRemove(row.id); return }
              setConfirmRemove(undefined)
              void run(async (signal) => { await props.remove(row.id, signal); if (!signal.aborted && editing?.id === row.id) cancelEdit() }, 'removed')
            }}>{props.t(confirmRemove === row.id ? 'confirmRemove' : 'remove')}</Button>
            {confirmRemove === row.id && <Button size="sm" disabled={busy} onClick={() => { setConfirmRemove(undefined) }}>{props.t('cancel')}</Button>}
          </div>
        </li>)}
      </ul>
    </div>
  </Modal>
}
