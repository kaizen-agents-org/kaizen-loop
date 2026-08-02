/**
 * Profiles are vendored into the package so `init` stays network-independent.
 * `.github/onboarding/profiles/` remains the source of truth; the copy under
 * `profiles/` is synced from it.
 */
export declare function bundledProfilesDir(): string;
/**
 * Organization safety floor for onboarded repositories.
 *
 * These entries mirror REQUIRED_PROTECTED_PATHS in the `.github` onboarding
 * contract checker. The checker validates the final config, so a profile that
 * drops one of these would only fail later, during acceptance. Re-applying the
 * floor here makes the overlay unable to remove it in the first place.
 */
export declare const SAFETY_FLOOR_PROTECTED_PATHS: string[];
export declare const SAFETY_FLOOR_FORBIDDEN_PATHS: string[];
export declare const SAFETY_FLOOR_MAX_WIP_LIMIT = 5;
export interface ProfileOverlay {
    name: string;
    source: string;
    values: Record<string, unknown>;
}
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/**
 * Resolve a `--profile` argument to a file path.
 *
 * A bare name resolves inside `profilesDir`; anything containing a separator or
 * a `.yml`/`.yaml` suffix is treated as a caller-supplied path.
 */
export declare function resolveProfilePath(profile: string, profilesDir: string): string;
export declare function loadProfile(profile: string, profilesDir: string): Promise<ProfileOverlay>;
/**
 * Deep-merge the overlay onto the base config.
 *
 * Mappings merge key by key; every other value (including arrays) is replaced
 * wholesale, so a profile states a list it wants rather than appending to one
 * it cannot see.
 */
export declare function mergeOverlay(base: unknown, overlay: unknown): unknown;
/**
 * Re-apply the organization safety floor after an overlay has been merged.
 *
 * Returns the corrected config plus the list of corrections, so `init` can tell
 * the operator what their profile tried to weaken instead of silently fixing it.
 */
export declare function applySafetyFloor(config: Record<string, unknown>): {
    config: Record<string, unknown>;
    corrections: string[];
};
