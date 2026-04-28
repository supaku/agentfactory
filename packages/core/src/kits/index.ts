/**
 * Kits — public API barrel
 *
 * Re-exports the full Kit subsystem: manifest schema + parser, detection
 * runtime, and composition algorithm.
 *
 * Architecture reference: rensei-architecture/005-kit-manifest-spec.md
 */

// Manifest types and parser
export type {
  KitIdentity,
  KitSupports,
  KitRequires,
  KitDetect,
  ContentMatch,
  ToolchainDemand,
  KitCommandSet,
  KitPromptFragment,
  ToolPermissionGrant,
  McpServerSpec,
  SkillRef,
  AgentDefinitionRef,
  A2ASkillRef,
  IntelligenceExtractorRef,
  KitWorkareaConfig,
  KitToolchainInstall,
  KitCommandsOverride,
  KitHooksBase,
  KitHooks,
  KitComposition,
  KitOrderGroup,
  KitProvide,
  KitManifest,
  KitDetectResult,
  KitManifestValidationResult,
} from './manifest.js'

export {
  KIT_API_VERSION,
  parseToml,
  parseKitManifest,
  loadKitManifestFile,
  validateKitManifest,
} from './manifest.js'

// Detection runtime
export type {
  FileTreeView,
  KitDetectTarget,
  ExecutableDetectOptions,
  KitCandidate,
  ConflictError,
  SelectionResult,
} from './detect.js'

export {
  isPlatformCompatible,
  evaluateDeclarativeDetect,
  isKitTrustedForExec,
  runExecutableDetect,
  detectKits,
  selectKits,
  mergeToolchainDemands,
} from './detect.js'

// Composition algorithm
export type {
  ComposedHook,
  ComposedHooks,
  KitComposedResult,
  ComposeOptions,
} from './compose.js'

export {
  composeKits,
  resolveToolchainInstall,
} from './compose.js'
