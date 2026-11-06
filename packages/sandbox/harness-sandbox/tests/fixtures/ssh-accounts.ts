/** Native test accounts and fixed SSH bindings, published before Loader evaluates the backend row. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import type { MultiuserUser } from '@deepseek-ai/dsh-api-multiuser'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceSshBinding } from '../../src/ssh-config.ts'

interface Account { user: MultiuserUser; workspace: Workspace; password: string }
declare module '@deepseek-ai/cordis' {
  interface Context { workspaceSshFixture: WorkspaceSshFixture }
}

export default class WorkspaceSshFixture extends Service {
  static inject = ['multiuser']
  readonly bindings: Record<string, WorkspaceSshBinding> = {}
  readonly accounts: Account[] = []
  constructor(ctx: Context) { super(ctx, 'workspaceSshFixture') }
  async [Service.init](): Promise<void> {
    const configFile = process.env.DSH_WORKSPACE_SSH_TEST_BINDINGS
    if (configFile === undefined) throw new Error('SSH acceptance needs an owned bindings file')
    const bindings = JSON.parse(await readFile(configFile, 'utf8')) as WorkspaceSshBinding[]
    if (bindings.length !== 2) throw new Error('SSH acceptance needs two independent test endpoints')
    for (const [index, binding] of bindings.entries()) {
      const password = randomUUID()
      const user = await this.ctx.multiuser.provisionUser(`ssh-user-${index}`, password)
      const workspace = await this.ctx.multiuser.createUserWorkspace(user.userId, `SSH ${index}`)
      this.accounts.push({ user, workspace, password })
      this.bindings[workspace.id] = binding
    }
  }
}
