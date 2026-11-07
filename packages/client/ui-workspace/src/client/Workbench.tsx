/** Task-first workspace presentation over the existing controller and sidebar slots. */
import { useRef, useState } from 'react'
import { Button, IconClockOutlineRegular, IconFolderOpenOutlineRegular, IconProjectAddOutlineRegular, IconShieldOutlineRegular, IconWorkspaceTreeOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceMode } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { WorkspaceFilesInjected } from './WorkspaceFilesButton.tsx'
import { DirectoryPanel } from './WorkspaceFilesButton.tsx'
import css from './Workbench.module.css'

/** Dashboard commands stay in the apply world. */
export interface WorkbenchInjected {
  prepare: (example: 'spreadsheet' | 'notes' | 'own', title: string, mode: WorkspaceMode) => Promise<void>
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
  const [mode, setMode] = useState<WorkspaceMode>('single-docker')
  const prepare = async (example: 'spreadsheet' | 'notes' | 'own') => {
    setPending(true); setProblem(false)
    try { await props.prepare(example, title, mode); setCreating(false) }
    catch (_error) { setProblem(true) }
    finally { setPending(false) }
  }
  return <div className={css.page}>
    <header className={css.top}><span>{t('dashboard')}</span><span className={css.topHint}>{t('private')}</span></header>
    <div className={css.content}>
      <section className={css.hero}>
        <span className={css.eyebrow}>{t('eyebrow')}</span>
        <h1>{t('headline')}</h1><p>{t('intro')}</p>
        <div className={css.heroActions}>
          <Button variant="primary" onClick={() => { setCreating(true); setProblem(false) }}><IconProjectAddOutlineRegular size={17} />{t('newTask')}</Button>
          <span className={css.trust}><IconShieldOutlineRegular size={15} />{t('retention')}</span>
        </div>
      </section>
      <section><div className={css.sectionHead}><div><h2>{t('examples')}</h2><p>{t('examplesHint')}</p></div><span className={css.counter}>01 — 03</span></div>
        <div className={css.examples}>
          {(['spreadsheet', 'notes', 'own'] as const).map((id, i) => {
            const Icon = id === 'spreadsheet' ? IconProjectAddOutlineRegular
              : id === 'notes' ? IconWorkspaceTreeOutlineRegular : IconFolderOpenOutlineRegular
            return <article key={id} className={css.example}>
              <div className={css.exampleTop}>
                <span className={css.exampleIcon}><Icon size={23} /></span><span className={css.number}>0{i + 1}</span>
              </div>
              <h3>{t(id === 'own' ? 'ownFiles' : id)}</h3><p>{t(id === 'own' ? 'ownFilesHint' : id === 'notes' ? 'notesHint' : 'spreadsheetHint')}</p>
              <Button variant="ghost" disabled={pending} onClick={() => { if (id === 'own') setCreating(true); else void prepare(id) }}>{t(id === 'own' ? 'newTask' : 'tryExample')}<span aria-hidden>↗</span></Button>
            </article>
          })}
        </div>
        {problem && <p role="alert" className={css.error}>{t('failed')}</p>}
      </section>
      <div className={css.lower}>
        <section><div className={css.sectionHead}><div><h2>{t('projects')}</h2><p>{t('projectsHint')}</p></div><span className={css.counter}>{String(workspaces.length).padStart(2, '0')}</span></div>
          {workspaces.length === 0 ? <div className={css.empty}><IconFolderOpenOutlineRegular size={28} /><h3>{t('empty')}</h3><p>{t('emptyHint')}</p></div>
            : <div className={css.projects}>{workspaces.map(workspace => <button
              key={workspace.workspaceId} className={css.project}
              onClick={() => { void props.open(workspace.workspaceId).catch(() => { setProblem(true) }) }}>
              <span className={css.projectIcon}><IconFolderOpenOutlineRegular size={19} /></span><span className={css.projectText}><span>{workspace.title}</span><small>{t('sessionCount', { n: workspace.sessionIds.length })} · {t(workspace.modeConfig.mode.startsWith('single-') ? 'single' : 'multi')}</small></span><span className={css.openLabel}>{t('continue')} ↗</span>
            </button>)}</div>}
        </section>
        <section className={css.how}><h2>{t('howTitle')}</h2>{(['One', 'Two', 'Three'] as const).map((suffix, i) => <div key={suffix} className={css.howStep}><span>{i + 1}</span><div><h3>{t(`how${suffix}`)}</h3><p>{t(`how${suffix}Hint`)}</p></div></div>)}<div className={css.model}><IconClockOutlineRegular size={16} /><span>{t('modelHint')}</span></div></section>
      </div>
    </div>
    <Modal open={creating} onClose={() => { if (!pending) setCreating(false) }} title={t('setup')} closeLabel={t('cancel')}>
      <div className={css.create}><p>{t('setupHint')}</p><label>{t('name')}<Input value={title} placeholder={t('namePlaceholder')} onChange={(event) => { setTitle(event.target.value) }} /></label>
        <fieldset className={css.modes} disabled={pending}>{(['single-docker', 'multi-docker'] as const).map(value => <label key={value} className={css.mode} data-selected={mode === value || undefined}><input type="radio" name="workbench-mode" checked={mode === value} onChange={() => { setMode(value) }} /><span><span>{t(value === 'single-docker' ? 'single' : 'multi')}</span><small>{t(value === 'single-docker' ? 'singleHint' : 'multiHint')}</small></span></label>)}</fieldset>
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
/** @param props - Sidebar brand geometry. @returns The existing workspace glyph. */
export function WorkbenchMark(props: PropsRuntime<'sidebar.brand.mark'>) { return <IconWorkspaceTreeOutlineRegular size={props.size} /> }
/** @param props - Empty-state brand geometry. @returns The existing workspace glyph. */
export function WorkbenchHeroMark(props: PropsRuntime<'conversation.hero.brand.mark'>) { return <IconWorkspaceTreeOutlineRegular size={props.size} className={props.className} /> }

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
