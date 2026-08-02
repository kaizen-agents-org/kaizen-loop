export function runtimeIdentity(env = process.env) {
    return {
        commit: env.KAIZEN_RUNTIME_COMMIT || 'development-build',
        ...(env.KAIZEN_RUNTIME_DIR ? { directory: env.KAIZEN_RUNTIME_DIR } : {})
    };
}
//# sourceMappingURL=runtime.js.map