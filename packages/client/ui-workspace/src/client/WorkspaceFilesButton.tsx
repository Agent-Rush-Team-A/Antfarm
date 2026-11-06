/** Workspace-scoped file browser with manually refreshed folders and complete downloads. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconFolderOpenOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceArtifactFiles } from '@deepseek-ai/dsh-api-workspace-artifacts/client'
import type { WorkspaceArtifactFailureReason, WorkspaceArtifactListing } from '@deepseek-ai/dsh-api-workspace-artifacts/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WorkspaceFilesButton.module.css'
import { fileFailureKey } from './file-failures.ts'

/** Narrow file operations; notices are owned by the application's toast host. */
export interface WorkspaceFilesInjected {
  /** Read bounded metadata through the optional browser provider. */
  listFiles: WorkspaceArtifactFiles['listFiles']
  /** Download complete bytes and report acceptance or refusal through the global toast. */
  downloadFile(this: void, workspaceId: WorkspaceId, path: string, maxBytes: number, signal: AbortSignal): Promise<void>
}

type Props = PropsRuntime<'conversation.input.left'> & PropsLocale<'workspace'> & InjectFace<WorkspaceFilesInjected>

/**
 * Resolve the current Session's registered workspace without activating a sandbox.
 * @param props - framework workspace snapshots, access hook and file callbacks.
 * @returns the optional file action, or nothing for an unassigned Session.
 */
export function WorkspaceFilesButton(props: Props) {
  const workspaceId = props.useWorkspaces(snapshot =>
    snapshot.items.find(workspace => workspace.sessionIds.includes(props.sessionId))?.workspaceId)
  return workspaceId === undefined ? null : <FilesAction key={workspaceId} {...props} workspaceId={workspaceId} />
}

function FilesAction({ workspaceId, useWorkspaceAccess, listFiles, downloadFile, t }: Props & { workspaceId: WorkspaceId }) {
  const allowed = useWorkspaceAccess(workspaceId, 'workspaceArtifacts/list')
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  if (!allowed) return null
  return <>
    <Tooltip label={t('files.action')} side="top" portal>
      <Button variant="toolbar" size="sm" aria-label={t('files.action')}
        onClick={() => { setPath(''); setOpen(true) }}>
        <IconFolderOpenOutlineRegular size={18} />
      </Button>
    </Tooltip>
    <Modal open={open} onClose={() => { setOpen(false) }} closeLabel={t('close')} title={t('files.action')}>
      {open && <DirectoryPanel key={path} workspaceId={workspaceId} path={path} navigate={setPath}
        listFiles={listFiles} downloadFile={downloadFile} t={t} />}
    </Modal>
  </>
}

type DirectoryProps = Pick<Props, 'listFiles' | 'downloadFile' | 't'> & {
  workspaceId: WorkspaceId
  path: string
  navigate(this: void, path: string): void
}

function DirectoryPanel({ workspaceId, path, navigate, listFiles, downloadFile, t }: DirectoryProps) {
  const [listing, setListing] = useState<WorkspaceArtifactListing>()
  const [failure, setFailure] = useState<WorkspaceArtifactFailureReason>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<string>()
  const download = useRef<AbortController>()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailure(undefined)
    void listFiles(workspaceId, path, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setLoading(false)
      if (result.ok) setListing(result.value)
      else setFailure(result.error.reason)
    })
    return () => { controller.abort() }
  }, [workspaceId, path, listFiles, refresh])
  useEffect(() => () => { download.current?.abort() }, [])
  return <div className={css.panel}>
    <div className={css.toolbar}>
      <span className={css.path}>{path === '' ? t('files.root') : path}</span>
      <div className={css.actions}>
        {path !== '' && <Button variant="outline" size="sm" onClick={() =>{  navigate(path.split('/').slice(0, -1).join('/')) }}>
          {t('files.up')}
        </Button>}
        <Button variant="outline" size="sm" disabled={loading} onClick={() => { setRefresh(value => value + 1) }}>
          {t('files.refresh')}
        </Button>
      </div>
    </div>
    {loading && <div role="status">{t('files.loading')}</div>}
    {failure !== undefined && <div role="alert">{t(fileFailureKey(failure))}</div>}
    {listing !== undefined && <>
      {listing.truncated && <div role="status">{t('files.truncated')}</div>}
      {listing.entries.length === 0 && <div>{t('files.empty')}</div>}
      <ul className={css.list} aria-label={t('files.action')}>
        {listing.entries.map((entry) => {
          const target = path === '' ? entry.name : path + '/' + entry.name
          return <li className={css.row} key={entry.name}>
            <div className={css.name}>
              {entry.kind === 'directory'
                ? <Button variant="ghost" aria-label={t('files.open', { name: entry.name })} onClick={() =>{  navigate(target) }}>
                  {entry.name}
                </Button>
                : <span>{entry.name}</span>}
              {entry.bytes !== undefined && <span className={css.bytes}>{t('files.bytes', { n: entry.bytes })}</span>}
            </div>
            {entry.kind === 'file' && <Button variant="outline" size="sm"
              aria-label={t('files.download', { name: entry.name })} disabled={downloading !== undefined}
              aria-busy={downloading === entry.name} onClick={() => {
                const controller = new AbortController()
                download.current = controller
                setDownloading(entry.name)
                void downloadFile(workspaceId, target, listing.maxDownloadBytes, controller.signal).finally(() => {
                  if (controller.signal.aborted) return
                  download.current = undefined
                  setDownloading(undefined)
                })
              }}>{t(downloading === entry.name ? 'files.downloading' : 'files.downloadAction')}</Button>}
          </li>
        })}
      </ul>
    </>}
  </div>
}
