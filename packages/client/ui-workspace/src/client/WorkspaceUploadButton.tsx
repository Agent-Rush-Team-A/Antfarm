/** Session composer entry for uploading into its registered workspace. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconProjectAddOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Upload action supplied by the optional Host capability. */
export interface WorkspaceUploadInjected {
  /** Upload the selected file and report its outcome through the shared toast. */
  uploadFile(this: void, workspaceId: WorkspaceId, file: File, signal: AbortSignal): Promise<void>
}

type Props = PropsRuntime<'conversation.input.left'> & PropsLocale<'workspace'> & InjectFace<WorkspaceUploadInjected>

/**
 * Resolve the current session's workspace through the framework snapshot.
 * @param props - session identity, workspace hooks, upload callback and locale.
 * @returns the workspace action, or nothing for an unassigned session.
 */
export function WorkspaceUploadButton(props: Props) {
  const workspaceId = props.useWorkspaces(snapshot =>
    snapshot.items.find(workspace => workspace.sessionIds.includes(props.sessionId))?.workspaceId)
  return workspaceId === undefined ? null : <UploadAction key={workspaceId} {...props} workspaceId={workspaceId} />
}

function UploadAction({ workspaceId, useWorkspaceAccess, uploadFile, t }: Props & { workspaceId: WorkspaceId }) {
  const allowed = useWorkspaceAccess(workspaceId, 'workspaceUpload/limits')
  const input = useRef<HTMLInputElement>(null)
  const operation = useRef<AbortController>()
  const [pending, setPending] = useState(false)
  useEffect(() => () => {
    operation.current?.abort()
    operation.current = undefined
  }, [])
  if (!allowed) return null
  const label = t(pending ? 'upload.pending' : 'upload.action')
  return <>
    <Tooltip label={label} side="top" portal>
      <Button variant="toolbar" size="sm" aria-label={label} aria-busy={pending}
        disabled={pending} onClick={() => input.current?.click()}>
        <IconProjectAddOutlineRegular size={18} />
      </Button>
    </Tooltip>
    <input ref={input} type="file" hidden aria-label={t('upload.action')} onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file === undefined || operation.current !== undefined) return
      const controller = new AbortController()
      operation.current = controller
      setPending(true)
      void uploadFile(workspaceId, file, controller.signal).finally(() => {
        if (operation.current === controller) {
          operation.current = undefined
          setPending(false)
        }
      })
    }} />
  </>
}
