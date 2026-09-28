/**
 * Version, in one place.
 *
 * The cache key includes it, so bumping the version invalidates every cached
 * file analysis automatically -- which is exactly what should happen when the
 * meaning of a measured value changes.
 */
export const VERSION = '1.0.0';

/** Schema version of the `--json` output. */
export const SCHEMA_VERSION = 1;
