/**
 * Plugin Loader Runtime — public API
 *
 * Re-exports all public types and functions from the plugin loader subsystem.
 *
 * Architecture reference: rensei-architecture/015-plugin-spec.md
 */

export type {
  PluginManifest,
  PluginMetadata,
  ProviderRegistration,
  VerbDeclaration,
  PluginEvents,
  PluginAuth,
  PluginSignature,
  PluginManifestValidationResult,
  PluginSignatureVerificationResult,
} from './manifest.js'

export {
  parsePluginManifest,
  loadPluginManifestFile,
  validatePluginManifest,
  verifyPluginSignature,
  hashPluginManifest,
  canonicalJsonPlugin,
  discoverPluginFiles,
} from './manifest.js'

export type {
  PluginLifecycleState,
  RegisteredPlugin,
  RegisteredProvider,
  RegisteredVerb,
} from './registry.js'

export {
  PluginRegistry,
  getDefaultRegistry,
  setDefaultRegistry,
} from './registry.js'

export type {
  DiscoverySource,
  PluginLoaderOptions,
  PluginInstallOptions,
  ProgrammaticRegistrationOptions,
  ProviderFactory,
  PluginLoadResult,
} from './loader.js'

export {
  PluginLoader,
  loadPluginFromYaml,
  loadPluginFromFile,
} from './loader.js'
