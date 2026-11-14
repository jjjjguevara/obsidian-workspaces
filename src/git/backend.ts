/** A repository snapshot taken inside the Git plugin's operation queue. */
export interface GitStatus {
  root: string;
  branch: string | null;
  dirty: boolean;
  conflicted: boolean;
}

/** Repository identity only; this does not assert working-tree cleanliness. */
export type GitIdentity = Pick<GitStatus, 'root' | 'branch'>;

/** Only valid for the duration of GitBackend.withRepository's callback. */
export interface GitRepository {
  inspect(): Promise<GitStatus>;
  /** Optional fast identity read for callers that do not need dirty/conflict state. */
  inspectIdentity?(): Promise<GitIdentity>;
  /** Start presentation immediately, but let its refresh overlap the rest of this queue scope. */
  overlapPresentation?(): void;
  assertCanSwitch(branch: string): Promise<void>;
  /** Revalidates current checkout safety even after an earlier preflight. */
  checkout(branch: string): Promise<GitIdentity>;
}

export interface GitBackend {
  /** Serializes the entire callback with the installed Git plugin's jobs. */
  withRepository<T>(operation: (repository: GitRepository) => Promise<T>): Promise<T>;
}

export type GitBackendErrorCode =
  | 'plugin-unavailable'
  | 'unsupported-platform'
  | 'unsupported-version'
  | 'unsupported-backend'
  | 'unsupported-submodules'
  | 'unsafe-runtime-files'
  | 'repository-changed'
  | 'repository-released'
  | 'git-command-failed'
  | 'invalid-status'
  | 'invalid-branch'
  | 'branch-not-found'
  | 'detached-head'
  | 'dirty-worktree'
  | 'conflicted-worktree'
  | 'operation-in-progress'
  | 'checkout-failed'
  | 'branch-mismatch'
  | 'queue-failed';

export interface GitBackendErrorOptions {
  /** Re-read after a failed checkout when possible; absence means unknown. */
  status?: GitStatus;
  cause?: unknown;
}

export class GitBackendError extends Error {
  readonly code: GitBackendErrorCode;
  readonly status: GitStatus | undefined;
  readonly cause: unknown;

  constructor(code: GitBackendErrorCode, message: string, options: GitBackendErrorOptions = {}) {
    super(message);
    this.name = 'GitBackendError';
    this.code = code;
    this.status = options.status;
    this.cause = options.cause;
  }
}
