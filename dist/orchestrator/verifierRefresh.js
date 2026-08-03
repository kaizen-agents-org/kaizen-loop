import fs from 'node:fs/promises';
import path from 'node:path';
import { getKaizenHome } from '../utils/paths.js';
import { RunLock } from './lock.js';
const COMPLETE_MARKER = '.kaizen-verifier-build-complete';
export async function refreshCanonicalVerifier(options) {
    if (options.config.safety.operationMode !== 'dogfood' || options.config.verifier.update.mode !== 'canonical-main') {
        throw new Error('canonical Verifier refresh is not enabled for this runtime');
    }
    const updateRoot = path.join(getKaizenHome(), 'runtime', 'verifier-update');
    const lock = await RunLock.acquire(updateRoot);
    try {
        const buildsRoot = path.join(getKaizenHome(), 'toolchain', 'verifier-builds');
        const buildRoot = path.join(buildsRoot, options.expectedCommit);
        const markerPath = path.join(buildRoot, COMPLETE_MARKER);
        const packageRoot = path.join(buildRoot, 'packages', 'core');
        await fs.mkdir(buildsRoot, { recursive: true });
        if (!await isCompleteBuild(markerPath, options.expectedCommit)) {
            await fs.rm(buildRoot, { recursive: true, force: true });
            try {
                await options.runCommand('git', [
                    'clone', '--no-checkout', '--filter=blob:none',
                    options.config.verifier.expectedRepository,
                    buildRoot
                ], { timeoutMs: options.config.verifier.update.timeoutMinutes * 60_000 });
                await options.runCommand('git', ['checkout', '--detach', options.expectedCommit], {
                    cwd: buildRoot,
                    timeoutMs: options.config.verifier.update.timeoutMinutes * 60_000
                });
                await options.runCommand('pnpm', ['install', '--frozen-lockfile'], {
                    cwd: buildRoot,
                    timeoutMs: options.config.verifier.update.timeoutMinutes * 60_000
                });
                await options.runCommand('pnpm', ['build'], {
                    cwd: buildRoot,
                    timeoutMs: options.config.verifier.update.timeoutMinutes * 60_000
                });
                await fs.writeFile(markerPath, `${options.expectedCommit}\n`);
            }
            catch (error) {
                await fs.rm(buildRoot, { recursive: true, force: true });
                throw error;
            }
        }
        await options.runCommand('pnpm', ['link', '--global'], {
            cwd: packageRoot,
            timeoutMs: options.config.verifier.update.timeoutMinutes * 60_000
        });
        return { packageRoot };
    }
    finally {
        await lock.release();
    }
}
export async function rollbackVerifierLink(options) {
    await options.runCommand('pnpm', ['link', '--global'], {
        cwd: options.packageRoot,
        timeoutMs: options.timeoutMinutes * 60_000
    });
}
async function isCompleteBuild(markerPath, expectedCommit) {
    try {
        return (await fs.readFile(markerPath, 'utf8')).trim() === expectedCommit;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=verifierRefresh.js.map