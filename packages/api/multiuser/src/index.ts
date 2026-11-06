/**
 * Multiuser accounts and workspace ownership. The service installs the
 * Connection admission provider, registers the `user` Remote access policy,
 * persists accounts/logins/owners, and serves `/auth/login`, `/auth/logout`,
 * `/auth/me`, and `/auth/client.js`.
 * @module @deepseek-ai/dsh-api-multiuser
 */

export { MultiuserService as default, MultiuserService, CONFIG_SCHEMA as Config } from './service.ts'
export type { Config as MultiuserConfig, LoginOutcome, AuthenticatedLogin } from './service.ts'
export type { MultiuserUser, LoginRequest, LoginValue } from './types.ts'
export type { MultiuserAccessIndex } from './policy.ts'
export { hashPassword, verifyPassword, tokenDigest, newLoginToken } from './password.ts'
export { multiuserDomainSpec } from './spec.ts'
export type { LoginSessionRecord, PasswordDigest, UserRecord, WorkspaceOwnerRecord } from './spec.ts'
