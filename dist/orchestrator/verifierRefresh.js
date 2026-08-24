import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { getKaizenHome } from '../utils/paths.js';
import { RunLock } from './lock.js';
const COMPLETE_MARKER = '.kaizen-verifier-build-complete';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export async function refreshCanonicalVerifier(options) {
    if (options.config.safety.operationMode !== 'dogfood' || options.config.verifier.update.mode !== 'canonical-main') {
        throw new Error('canonical Verifier refresh is not enabled for this runtime');
    }
    if (!COMMIT_PATTERN.test(options.expectedCommit)) {
        throw new Error(`refusing to build an invalid Verifier commit: ${options.expectedCommit}`);
    }
    const globalLink = await resolveGlobalVerifierLink(options.previousPackageRoot, options.executableSearchPath ?? process.env.PATH ?? '');
    const lock = await RunLock.acquire(path.join(path.dirname(globalLink), '.kaizen-update-lock'));
    try {
        const buildsRoot = path.join(getKaizenHome(), 'toolchain', 'verifier-builds');
        await fs.mkdir(buildsRoot, { recursive: true });
        const managedRoot = await fs.realpath(buildsRoot);
        const buildRoot = path.join(managedRoot, `${options.expectedCommit}-${process.pid}-${Date.now()}`);
        assertManagedChild(managedRoot, buildRoot);
        const packageRoot = path.join(buildRoot, 'packages', 'core');
        const timeoutMs = options.config.verifier.update.timeoutMinutes * 60_000;
        try {
            await options.runCommand('git', [
                'clone', '--no-checkout', '--filter=blob:none',
                options.config.verifier.expectedRepository,
                buildRoot
            ], { timeoutMs });
            await rejectSymlink(buildRoot);
            await options.runCommand('git', ['checkout', '--detach', options.expectedCommit], {
                cwd: buildRoot,
                timeoutMs
            });
            const checkedOut = await options.runCommand('git', ['rev-parse', 'HEAD'], {
                cwd: buildRoot,
                timeoutMs
            });
            if (checkedOut.stdout.trim() !== options.expectedCommit) {
                throw new Error(`Verifier checkout resolved to ${checkedOut.stdout.trim() || '<empty>'}, expected ${options.expectedCommit}`);
            }
            await options.runCommand('pnpm', ['install', '--frozen-lockfile'], { cwd: buildRoot, timeoutMs });
            await options.runCommand('pnpm', ['build'], { cwd: buildRoot, timeoutMs });
            const cliPath = path.join(packageRoot, 'dist', 'cli.js');
            await fs.access(cliPath);
            await fs.chmod(cliPath, 0o755);
            if (((await fs.stat(cliPath)).mode & 0o111) === 0) {
                throw new Error(`built Verifier CLI is not executable: ${cliPath}`);
            }
            await writeMarkerAtomically(buildRoot, options.expectedCommit);
            await replaceGlobalVerifierLink({
                globalLink,
                expectedCurrentPackageRoot: options.previousPackageRoot,
                nextPackageRoot: packageRoot
            });
            return new CanonicalVerifierRefresh(packageRoot, options.previousPackageRoot, globalLink, lock);
        }
        catch (error) {
            await fs.rm(buildRoot, { recursive: true, force: true });
            throw error;
        }
    }
    catch (error) {
        await lock.release();
        throw error;
    }
}
export class CanonicalVerifierRefresh {
    packageRoot;
    previousPackageRoot;
    globalLink;
    lock;
    released = false;
    constructor(packageRoot, previousPackageRoot, globalLink, lock) {
        this.packageRoot = packageRoot;
        this.previousPackageRoot = previousPackageRoot;
        this.globalLink = globalLink;
        this.lock = lock;
    }
    async rollback() {
        if (this.released)
            throw new Error('Verifier refresh transaction is already complete');
        await replaceGlobalVerifierLink({
            globalLink: this.globalLink,
            expectedCurrentPackageRoot: this.packageRoot,
            nextPackageRoot: this.previousPackageRoot
        });
    }
    async release() {
        if (this.released)
            return;
        this.released = true;
        await this.lock.release();
    }
}
async function resolveGlobalVerifierLink(previousPackageRoot, searchPath) {
    const expectedPackageRoot = await fs.realpath(previousPackageRoot);
    for (const directory of searchPath.split(path.delimiter)) {
        if (!path.isAbsolute(directory))
            continue;
        const command = path.join(directory, 'verifier');
        let commandStat;
        try {
            commandStat = await fs.lstat(command);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw error;
        }
        if (!commandStat.isSymbolicLink()) {
            throw new Error(`refusing to update a non-symlink Verifier command selected from PATH: ${command}`);
        }
        const commandTarget = path.resolve(path.dirname(command), await fs.readlink(command));
        if (path.basename(commandTarget) !== 'cli.js' || path.basename(path.dirname(commandTarget)) !== 'dist') {
            throw new Error(`Verifier command does not target a package dist/cli.js: ${command}`);
        }
        const globalLink = path.dirname(path.dirname(commandTarget));
        const linkStat = await fs.lstat(globalLink);
        if (!linkStat.isSymbolicLink()) {
            throw new Error(`refusing to replace non-symlink global Verifier package: ${globalLink}`);
        }
        const observedPackageRoot = await fs.realpath(globalLink);
        if (observedPackageRoot !== expectedPackageRoot) {
            throw new Error(`Verifier command selected from PATH resolves to ${observedPackageRoot}, expected ${expectedPackageRoot}`);
        }
        await fs.access(command, constants.X_OK);
        return globalLink;
    }
    throw new Error(`Verifier command was not found on the scheduled PATH: ${searchPath || '<empty>'}`);
}
async function replaceGlobalVerifierLink(options) {
    const linkStat = await fs.lstat(options.globalLink);
    if (!linkStat.isSymbolicLink()) {
        throw new Error(`refusing to replace non-symlink global Verifier package: ${options.globalLink}`);
    }
    const observedCurrent = await fs.realpath(options.globalLink);
    const expectedCurrent = await fs.realpath(options.expectedCurrentPackageRoot);
    if (observedCurrent !== expectedCurrent) {
        throw new Error(`global Verifier link changed concurrently (expected ${expectedCurrent}, found ${observedCurrent})`);
    }
    const nextPackageRoot = await fs.realpath(options.nextPackageRoot);
    const temporaryLink = path.join(path.dirname(options.globalLink), `.core-kaizen-${process.pid}-${Date.now()}`);
    try {
        await fs.symlink(nextPackageRoot, temporaryLink, 'dir');
        await fs.rename(temporaryLink, options.globalLink);
    }
    finally {
        await fs.rm(temporaryLink, { force: true });
    }
}
async function rejectSymlink(target) {
    if ((await fs.lstat(target)).isSymbolicLink()) {
        throw new Error(`refusing to build Verifier through a symlink: ${target}`);
    }
}
function assertManagedChild(root, candidate) {
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Verifier build path escapes the managed root: ${candidate}`);
    }
}
async function writeMarkerAtomically(buildRoot, expectedCommit) {
    const marker = path.join(buildRoot, COMPLETE_MARKER);
    const temporary = `${marker}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${expectedCommit}\n`, { flag: 'wx' });
    await fs.rename(temporary, marker);
}
//# sourceMappingURL=verifierRefresh.js.map