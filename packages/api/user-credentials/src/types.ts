/** Browser-safe requests and metadata for personal credentials. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of a personal credential. */
export type UserCredentialId = Branded<'UserCredentialId'>

/** Metadata returned without any part of the stored secret. */
export interface UserCredentialView {
  readonly id: UserCredentialId
  readonly name: string
  readonly configured: true
  readonly createdAt: string
  readonly updatedAt: string
}

/** A secret submitted once to the Host. */
export interface CreateCredentialRequest {
  readonly name: string
  readonly value: string
}

/** Address a record belonging to the authenticated caller. */
export interface CredentialRequest {
  readonly id: UserCredentialId
}

/** Replace a secret without reading the previous value. */
export interface ReplaceCredentialRequest extends CredentialRequest {
  readonly value: string
}

/** Refresh only a provider bound to one caller-owned credential. */
export interface RefreshCredentialModelsRequest extends CredentialRequest {
  /** Bypass directory freshness for a user-requested retry. @default false */
  readonly force?: boolean
}

/** Public directory status, independent of inference authorization. */
export interface CredentialModelCatalogResult {
  /** Ready list, retained stale list, failed load, or an unbound credential. */
  readonly status: 'ready' | 'stale' | 'failed' | 'unsupported'
  /** Number of models advertised after the attempt. */
  readonly modelCount: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A personal credential does not exist for the caller. */
    'user-credentials/not-found': {}
    /** Only an authenticated account can manage personal credentials. */
    'user-credentials/unauthorized': {}
    /** The request exceeds deployment limits or has invalid fields. */
    'user-credentials/invalid-request': {}
    /** The account has reached its credential limit. */
    'user-credentials/limit': {}
    /** Persistence or authenticated decryption failed. */
    'user-credentials/unavailable': {}
  }
}
