/** Task-first workspace presentation over the existing controller and sidebar slots. */
import { useRef, useState } from 'react'
import { Button, IconDataOutlineRegular, IconFolderOpenOutlineRegular, IconGaugeOutlineRegular, IconGlobeOutlineRegular, IconListPenOutlineRegular, IconProjectAddOutlineRegular, IconRefreshOutlineRegular, IconShieldOutlineRegular, IconWorkspaceTreeOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceMode } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { WorkspaceFilesInjected } from './WorkspaceFilesButton.tsx'
import { DirectoryPanel } from './WorkspaceFilesButton.tsx'
import css from './Workbench.module.css'

/** Dashboard commands stay in the apply world. */
export interface WorkbenchInjected {
  prepare: (example: 'spreadsheet' | 'notes' | 'own', title: string) => Promise<void>
  open: (workspaceId: WorkspaceId) => Promise<void>
}
type DashboardProps = PropsRuntime<'main'> & PropsLocale<'antfarm'> & InjectFace<WorkbenchInjected>

/** @param props - Workspace snapshots and preparation commands. @returns The task dashboard. */
export function Workbench(props: DashboardProps) {
  const { t } = props
  const workspaces = props.useWorkspaces(value => value.items)
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState(false)
  const [title, setTitle] = useState('')
  const prepare = async (example: 'spreadsheet' | 'notes' | 'own') => {
    setPending(true); setProblem(false)
    try { await props.prepare(example, title); setCreating(false) }
    catch (_error) { setProblem(true) }
    finally { setPending(false) }
  }
  const examples = [
    { id: 'spreadsheet', Icon: IconDataOutlineRegular, title: t('spreadsheet'), hint: t('spreadsheetHint'), file: 'sales.csv', action: t('tryExample') },
    { id: 'notes', Icon: IconListPenOutlineRegular, title: t('notes'), hint: t('notesHint'), file: 'brief.md', action: t('tryExample') },
    { id: 'own', Icon: IconFolderOpenOutlineRegular, title: t('ownFiles'), hint: t('ownFilesHint'), file: undefined, action: t('newTask') },
  ] as const
  const facts = [
    { key: 'factNetwork', Icon: IconGlobeOutlineRegular },
    { key: 'factSystem', Icon: IconShieldOutlineRegular },
    { key: 'factLimits', Icon: IconGaugeOutlineRegular },
    { key: 'factCleanup', Icon: IconRefreshOutlineRegular },
  ] as const
  return <div className={css.page}>
    <header className={css.top}><span>{t('dashboard')}</span></header>
    <div className={css.content}>
      <section className={css.hero}>
        <h1>{t('headline')}</h1><p>{t('intro')}</p>
        <div className={css.heroActions}>
          <Button variant="primary" onClick={() => { setCreating(true); setProblem(false) }}><IconProjectAddOutlineRegular size={16} />{t('newTask')}</Button>
          <span className={css.trust}><IconShieldOutlineRegular size={15} />{t('retention')}</span>
        </div>
      </section>
      <section className={css.block}>
        <div className={css.sectionHead}><h2>{t('examples')}</h2><p>{t('examplesHint')}</p></div>
        <ul className={css.examples}>
          {examples.map(({ id, Icon, title: heading, hint, file, action }) => <li key={id} className={css.example}>
            <span className={css.exampleIcon}><Icon size={19} /></span>
            <div className={css.exampleText}><h3>{heading}</h3><p>{hint}</p></div>
            {file === undefined ? <span /> : <code className={css.file}>{file}</code>}
            <Button variant="outline" size="sm" disabled={pending} onClick={() => { if (id === 'own') setCreating(true); else void prepare(id) }}>{action}</Button>
          </li>)}
        </ul>
        {problem && <p role="alert" className={css.error}>{t('failed')}</p>}
      </section>
      <div className={css.lower}>
        <section>
          <div className={css.sectionHead}><h2>{t('projects')}{workspaces.length > 0 && <span className={css.count}>{workspaces.length}</span>}</h2><p>{t('projectsHint')}</p></div>
          {workspaces.length === 0 ? <div className={css.empty}><IconFolderOpenOutlineRegular size={22} /><div><h3>{t('empty')}</h3><p>{t('emptyHint')}</p></div></div>
            : <ul className={css.projects}>{workspaces.map(workspace => <li key={workspace.workspaceId}><button
              type="button" className={css.project}
              onClick={() => { void props.open(workspace.workspaceId).catch(() => { setProblem(true) }) }}>
              <span className={css.projectIcon}><IconFolderOpenOutlineRegular size={18} /></span>
              <span className={css.projectText}><span>{workspace.title}</span><small><span>{t('sessionCount', { n: workspace.sessionIds.length })}</span><span>{t(workspace.modeConfig.mode.startsWith('single-') ? 'single' : 'multi')}</span></small></span>
              <span className={css.openLabel}>{t('continue')}</span>
            </button></li>)}</ul>}
        </section>
        <aside className={css.sandbox}>
          <h2>{t('sandboxTitle')}</h2>
          <ul className={css.facts}>{facts.map(({ key, Icon }) => <li key={key}><Icon size={17} /><span><b>{t(key)}</b><span>{t(`${key}Hint`)}</span></span></li>)}</ul>
          <p className={css.model}>{t('modelHint')}</p>
        </aside>
      </div>
    </div>
    <Modal open={creating} onClose={() => { if (!pending) setCreating(false) }} title={t('setup')} closeLabel={t('cancel')}>
      <div className={css.create}><p>{t('setupHint')}</p><label>{t('name')}<Input value={title} placeholder={t('namePlaceholder')} onChange={(event) => { setTitle(event.target.value) }} /></label>
        {problem && <p role="alert" className={css.error}>{t('failed')}</p>}
        <div className={css.createActions}><Button variant="outline" disabled={pending} onClick={() => { setCreating(false) }}>{t('cancel')}</Button><Button variant="primary" disabled={pending} onClick={() => { void prepare('own') }}>{t(pending ? 'creating' : 'create')}</Button></div>
      </div>
    </Modal>
  </div>
}

/** @param props - Sidebar icon geometry. @returns The existing workspace glyph. */
export function WorkbenchIcon(props: PropsRuntime<'sidebar.panellist'>) { return <IconWorkspaceTreeOutlineRegular size={props.size} /> }
/** @param props - Brand copy. @returns The Antfarm wordmark. */
export function WorkbenchBrand(props: PropsRuntime<'sidebar.brand.name'> & PropsLocale<'antfarm'>) { return <span className={css.brand}>{props.t('brand')}</span> }
/** @param props - Product heading copy. @returns The ready-to-work title. */
export function WorkbenchHero(props: PropsRuntime<'conversation.hero.brand.name'> & PropsLocale<'antfarm'>) { return <span>{props.t('readyTitle')}</span> }
/** @param props - Mark size and class. @returns The Antfarm glass-and-chambers mark. */
function AntfarmMark(props: { size?: number | undefined; className?: string | undefined }) {
  return <svg className={props.className} width={props.size} height={props.size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <rect x="1.75" y="1.75" width="24.5" height="24.5" rx="7" stroke="currentColor" strokeWidth="1.5" />
    <rect x="6.5" y="8" width="10" height="4.5" rx="2.25" className={css.markSand} />
    <rect x="11.5" y="15.5" width="10" height="4.5" rx="2.25" fill="currentColor" />
  </svg>
}
/** @param props - Sidebar brand geometry. @returns The Antfarm mark. */
export function WorkbenchMark(props: PropsRuntime<'sidebar.brand.mark'>) { return <AntfarmMark size={props.size} /> }
/** @param props - Empty-state brand geometry. @returns The Antfarm mark. */
export function WorkbenchHeroMark(props: PropsRuntime<'conversation.hero.brand.mark'>) { return <AntfarmMark size={props.size} className={props.className} /> }

/**
 * Host the account controls inside the sidebar instead of a fixed page overlay.
 * @param props - Current sidebar column state.
 * @returns An account-control host hidden in the collapsed rail.
 */
export function WorkbenchAccountDock(props: PropsRuntime<'sidebar.footer.action'>) {
  return <div className={css.accountDock} data-dsh-account-dock="" data-wide={props.wide || undefined} />
}

/** File panel operations reuse the existing upload and download providers. */
export interface WorkbenchFilesInjected extends WorkspaceFilesInjected {
  fileCopy: Parameters<typeof DirectoryPanel>[0]['t']
  /** Upload outcomes distinguish a refused file from an interrupted connection. */
  uploadFile: (workspaceId: WorkspaceId, file: File, signal: AbortSignal) => Promise<'uploaded' | 'failed' | 'disconnected'>
}
type FileProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'antfarm'> & InjectFace<WorkbenchFilesInjected> & PropsRenderSlots<'workspace.files.environment'>


/** @param props - Current Session and scoped file operations. @returns The persistent workspace panel. */
export function WorkbenchFiles(props: FileProps) {
  const workspace = props.useWorkspaces(value => value.items.find(row => row.sessionIds.includes(props.sessionId)))
  return workspace === undefined ? null : <WorkspaceFiles
    key={workspace.workspaceId} {...props} workspaceId={workspace.workspaceId} mode={workspace.modeConfig.mode} />
}
function WorkspaceFiles(props: FileProps & { workspaceId: WorkspaceId; mode: WorkspaceMode }) {
  const { t, workspaceId } = props
  const [path, setPath] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProblem, setUploadProblem] = useState<'uploadFailed' | 'uploadDisconnected' | null>(null)
  const [revision, setRevision] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const running = props.useSession(value => value.running)
  return <div className={css.filePanel}>
    {props.renderSlot('workspace.files.environment', { workspaceId, mode: props.mode })}
    <div className={css.fileHead}><div><h2>{t('files')}</h2><p>{t('filesHint')}</p></div><Button variant="outline" size="sm" disabled={uploading} onClick={() => input.current?.click()}><IconProjectAddOutlineRegular size={15} />{t(uploading ? 'uploading' : 'upload')}</Button></div>
    <input ref={input} type="file" hidden aria-label={t('upload')} onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file === undefined) return
      setUploading(true)
      setUploadProblem(null)
      void (async () => {
        try {
          const result = await props.uploadFile(workspaceId, file, new AbortController().signal)
          if (result === 'uploaded') setRevision(value => value + 1)
          else setUploadProblem(result === 'failed' ? 'uploadFailed' : 'uploadDisconnected')
        } catch (_uploadInterrupted) {
          setUploadProblem('uploadDisconnected')
        } finally {
          setUploading(false)
        }
      })()
    }} />
    {uploadProblem !== null && <p role="alert" className={css.error}>{t(uploadProblem)}</p>}
    <DirectoryPanel workspaceId={workspaceId} path={path} navigate={setPath} listFiles={props.listFiles} downloadFile={props.downloadFile} t={props.fileCopy} refreshToken={`${revision}:${String(running)}`} />
    <p className={css.retained}><IconShieldOutlineRegular size={15} />{t('retained')}</p>
  </div>
}
