/**
 * Getting a clip onto a platform: the target connectors, the hosting seam, and
 * the pipeline that runs caption → host → upload → poll.
 *
 * One isolated module per platform under `targets/`, each reporting
 * `isConfigured()` honestly so the UI never pretends a connector works before
 * its credentials exist. `ClipHosting` is a separate seam because IG and TikTok
 * require a public HTTPS URL and a local path is never sufficient.
 *
 * The top of the stack: depends on `captioning/`, and nothing depends on it.
 */
export type {
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from './PublishTarget';
export { publishService } from './PublishService';
export type { PublishOptions } from './PublishService';

export type { ClipHosting } from './ClipHosting';
export { MockClipHosting } from './ClipHosting';
export { PresignedUrlClipHosting } from './PresignedUrlClipHosting';

// Connector credentials live in `core/ConnectorConfig` rather than here: the
// same store carries the captioning service URL, so keeping it under
// publishing/ meant captioning had to import publishing to read one field —
// a cycle for no reason beyond where the file sat.
