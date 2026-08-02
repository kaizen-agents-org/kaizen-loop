import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { ConfigError } from '../utils/errors.js';
/**
 * Profiles are vendored into the package so `init` stays network-independent.
 * `.github/onboarding/profiles/` remains the source of truth; the copy under
 * `profiles/` is synced from it.
 */
export function bundledProfilesDir() {
    return path.join(import.meta.dirname, '..', '..', 'profiles');
}
/**
 * Organization safety floor for onboarded repositories.
 *
 * These entries mirror REQUIRED_PROTECTED_PATHS in the `.github` onboarding
 * contract checker. The checker validates the final config, so a profile that
 * drops one of these would only fail later, during acceptance. Re-applying the
 * floor here makes the overlay unable to remove it in the first place.
 */
export const SAFETY_FLOOR_PROTECTED_PATHS = [
    '.github/**',
    '**/.env*',
    '**/secrets/**',
    '**/*migration*/**',
    '.kaizen/**'
];
export const SAFETY_FLOOR_FORBIDDEN_PATHS = ['**/.git/**'];
export const SAFETY_FLOOR_MAX_WIP_LIMIT = 5;
/** Keys an overlay may not set at all, because they decide the trust model. */
const REJECTED_OVERLAY_PATHS = [
    'policy.mode',
    'verifier.enabled',
    'safety.operationMode'
];
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Resolve a `--profile` argument to a file path.
 *
 * A bare name resolves inside `profilesDir`; anything containing a separator or
 * a `.yml`/`.yaml` suffix is treated as a caller-supplied path.
 */
export function resolveProfilePath(profile, profilesDir) {
    if (profile.includes('/') || profile.includes(path.sep) || /\.ya?ml$/.test(profile)) {
        return path.resolve(profile);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(profile)) {
        throw new ConfigError(`Invalid profile name: ${profile}. Use letters, digits, and hyphens, or pass a path to a profile file.`);
    }
    return path.join(profilesDir, `${profile}.yml`);
}
export async function loadProfile(profile, profilesDir) {
    const source = resolveProfilePath(profile, profilesDir);
    let raw;
    try {
        raw = await fs.readFile(source, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new ConfigError(`Profile not found: ${source}`);
        }
        throw new ConfigError(`Unable to read profile at ${source}: ${String(error)}`);
    }
    let parsed;
    try {
        parsed = parse(raw);
    }
    catch (error) {
        throw new ConfigError(`Profile at ${source} is not valid YAML: ${String(error)}`);
    }
    if (!isPlainObject(parsed)) {
        throw new ConfigError(`Profile at ${source} must be a YAML mapping of config overrides.`);
    }
    for (const rejected of REJECTED_OVERLAY_PATHS) {
        if (hasPath(parsed, rejected)) {
            throw new ConfigError(`Profile at ${source} sets ${rejected}, which is fixed by the organization safety floor and cannot be overridden by a profile.`);
        }
    }
    return { name: path.basename(source).replace(/\.ya?ml$/, ''), source, values: parsed };
}
function hasPath(value, dottedPath) {
    const segments = dottedPath.split('.');
    let cursor = value;
    for (const segment of segments) {
        if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment))
            return false;
        cursor = cursor[segment];
    }
    return true;
}
/**
 * Deep-merge the overlay onto the base config.
 *
 * Mappings merge key by key; every other value (including arrays) is replaced
 * wholesale, so a profile states a list it wants rather than appending to one
 * it cannot see.
 */
export function mergeOverlay(base, overlay) {
    if (!isPlainObject(base) || !isPlainObject(overlay))
        return overlay;
    const merged = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        merged[key] = Object.prototype.hasOwnProperty.call(base, key)
            ? mergeOverlay(base[key], value)
            : value;
    }
    return merged;
}
/**
 * Re-apply the organization safety floor after an overlay has been merged.
 *
 * Returns the corrected config plus the list of corrections, so `init` can tell
 * the operator what their profile tried to weaken instead of silently fixing it.
 */
export function applySafetyFloor(config) {
    const corrections = [];
    const result = structuredClone(config);
    const policy = isPlainObject(result.policy) ? result.policy : {};
    const protectedPaths = Array.isArray(policy.protectedPaths)
        ? policy.protectedPaths.filter((entry) => typeof entry === 'string')
        : [];
    const missingProtected = SAFETY_FLOOR_PROTECTED_PATHS.filter((entry) => !protectedPaths.includes(entry));
    if (missingProtected.length > 0) {
        policy.protectedPaths = [...missingProtected, ...protectedPaths];
        corrections.push(`restored policy.protectedPaths entries: ${missingProtected.join(', ')}`);
    }
    const forbiddenPaths = Array.isArray(policy.forbiddenPaths)
        ? policy.forbiddenPaths.filter((entry) => typeof entry === 'string')
        : [];
    const missingForbidden = SAFETY_FLOOR_FORBIDDEN_PATHS.filter((entry) => !forbiddenPaths.includes(entry));
    if (missingForbidden.length > 0) {
        policy.forbiddenPaths = [...missingForbidden, ...forbiddenPaths];
        corrections.push(`restored policy.forbiddenPaths entries: ${missingForbidden.join(', ')}`);
    }
    result.policy = policy;
    const safety = isPlainObject(result.safety) ? result.safety : {};
    const wipLimit = safety.wipLimit;
    if (typeof wipLimit === 'number' && wipLimit > SAFETY_FLOOR_MAX_WIP_LIMIT) {
        safety.wipLimit = SAFETY_FLOOR_MAX_WIP_LIMIT;
        corrections.push(`lowered safety.wipLimit from ${wipLimit} to ${SAFETY_FLOOR_MAX_WIP_LIMIT}`);
    }
    result.safety = safety;
    return { config: result, corrections };
}
//# sourceMappingURL=profile.js.map