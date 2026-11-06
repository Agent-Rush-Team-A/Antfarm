/** Wire values and stable identities of the multiuser API. */

import type { UserId } from '@deepseek-ai/dsh-typert-protocol'

/** Public account fields safe to return to a browser. */
export interface MultiuserUser {
  readonly userId: UserId
  readonly username: string
}

/** Login request body. */
export interface LoginRequest {
  readonly username: string
  readonly password: string
}

/** Login success body. */
export interface LoginValue {
  readonly user: MultiuserUser
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The supplied account name or password is not valid. */
    'multiuser/invalid-credentials': {}
    /** The deployment refused another login attempt in the current window. */
    'multiuser/rate-limited': { readonly retryAfterMs: number }
    /** The account is disabled or no longer exists. */
    'multiuser/account-disabled': {}
  }
}
