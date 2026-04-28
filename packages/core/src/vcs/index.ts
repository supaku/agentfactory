/**
 * VCS module — VersionControlProvider abstraction + GitHub adapter
 *
 * Architecture reference: rensei-architecture/008-version-control-providers.md
 */

export type {
  VersionControlProvider,
  VersionControlProviderCapabilities,
  Workspace,
  CloneOpts,
  CellChange,
  KitProviderId,
  WorkareaSnapshotRef,
  SessionAttestation,
  ChangeRequest,
  ChangeRef,
  PushTarget,
  PushResult,
  PullSource,
  VCSMergeResult,
  ProposalOpts,
  ProposalRef,
  MergeStrategy,
  MergeQueueOpts,
  QueueTicket,
  Conflict,
  AutoResolution,
  Resolution,
  AttestationRef,
} from './types.js'

export { UnsupportedOperationError, assertCapability } from './types.js'
export { GitHubVCSProvider, GITHUB_VCS_CAPABILITIES, buildCommitMessageWithTrailers, buildAttestationTrailers } from './github.js'
