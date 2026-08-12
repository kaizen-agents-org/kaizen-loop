import fs from 'node:fs/promises';
import path from 'node:path';
import { BuilderAgentAdapter } from '../agents/builder.js';
import { ClaudeCodeAdapter } from '../agents/claude.js';
import { CodexAdapter } from '../agents/codex.js';
import { assertVerifierRuntimeFresh } from '../agents/verifierFreshness.js';
import { loadConfig } from '../config/config.js';
import { configDrift } from '../config/operational.js';
import { resolveProject } from '../config/registry.js';
import { DISPOSITION_LABELS } from '../orchestrator/disposition.js';
import { GitHubClient } from '../github/client.js';
import { isPrGuardianSkillRunnerAvailable } from '../orchestrator/prGuardian.js';
import { projectStateDir, worktreesDirForWorkspace } from '../utils/paths.js';
import { assertPrivateDirectory, makeDirectoryPrivate } from '../utils/privateDirectory.js';
import { ensureKaizenTempDir } from '../utils/temp.js';
import { tailText } from '../utils/text.js';
import { runtimeIdentity } from '../utils/runtime.js';
export async function doctorProject(options) {
    const checks = [];
    const resolved = await resolveProject(options.project, options.cwd);
    let localConfig;
    let workspaceConfig;
    await check(checks, 'config', async () => {
        localConfig = await loadConfig(resolved.project.localPath);
    });
    await check(checks, 'workspace config', async () => {
        workspaceConfig = await loadConfig(resolved.project.workspacePath);
    });
    const config = workspaceConfig ?? localConfig;
    const configPath = workspaceConfig ? resolved.project.workspacePath : resolved.project.localPath;
    const drift = localConfig && workspaceConfig
        ? configDrift(localConfig, workspaceConfig, resolved.project)
        : undefined;
    await check(checks, 'gh auth', async () => void (await new GitHubClient(options.runCommand, configPath).authStatus()));
    await check(checks, 'github labels', async () => {
        const loaded = config;
        if (!loaded)
            throw new Error('config unavailable');
        if (!options.repair)
            return;
        await new GitHubClient(options.runCommand, configPath).createLabels(requiredLabels(loaded));
    });
    await check(checks, 'workspace', async () => void (await fs.access(resolved.project.workspacePath)));
    await check(checks, 'workspace permissions', async () => {
        await checkWorkspacePermissions(resolved.project.workspacePath, resolved.slug, options.repair === true);
    });
    await check(checks, 'temporary directory', async () => void (await checkWorkspaceTempDir(resolved.project.workspacePath)));
    for (const agent of configuredAgents(config)) {
        await check(checks, `${agent} auth`, async () => {
            const adapter = agent === 'codex' ? new CodexAdapter(options.runCommand) : new ClaudeCodeAdapter(options.runCommand);
            if (!(await adapter.isAvailable()))
                throw new Error('unavailable');
        });
    }
    await check(checks, 'builder agent command', async () => {
        const loaded = config;
        if (!loaded)
            throw new Error('config unavailable');
        if (!(await new BuilderAgentAdapter(options.runCommand, builderOptions(loaded)).isAvailable()))
            throw new Error('unavailable');
    });
    await check(checks, 'builder agent runtime', async () => {
        const loaded = config;
        if (!loaded)
            throw new Error('config unavailable');
        await fs.access(resolved.project.workspacePath);
        const preferredBackend = loaded.agent.default;
        const fallbackBackend = preferredBackend === 'codex' ? 'claude' : 'codex';
        const preferredBackends = loaded.agent.fallback
            ? [preferredBackend, fallbackBackend]
            : [preferredBackend];
        const result = await new BuilderAgentAdapter(options.runCommand, builderOptions(loaded)).run({
            workspaceDir: resolved.project.workspacePath,
            prompt: [
                'Kaizen doctor smoke test.',
                'Do not inspect or edit files.',
                'Return only this JSON in a json code fence:',
                '{"status":"fixed","summary":"doctor smoke ok","notes":"","discoveredIssues":[]}'
            ].join('\n'),
            timeoutMs: 60_000,
            preferredBackends,
            model: loaded.agent.model[preferredBackend]
        });
        if (result.status !== 'fixed') {
            const reason = result.blockedReason || result.summary || 'builder agent did not complete smoke test';
            const notes = result.notes.trim();
            throw new Error(notes ? `${reason}: ${tailText(notes, 500)}` : reason);
        }
    });
    await check(checks, 'verifier agent', async () => {
        const loaded = config;
        if (!loaded)
            throw new Error('config unavailable');
        if (!loaded.verifier.enabled)
            return;
        await assertVerifierRuntimeFresh(loaded, options.runCommand);
    });
    await check(checks, 'pr guardian skill runner', async () => {
        const loaded = config;
        if (!loaded)
            throw new Error('config unavailable');
        if (!loaded.guardian.enabled)
            return;
        if (!(await isPrGuardianSkillRunnerAvailable(loaded, options.runCommand)))
            throw new Error('unavailable');
    });
    return {
        runtime: runtimeIdentity(),
        slug: resolved.slug,
        configuration: {
            source: workspaceConfig ? 'workspace' : 'local',
            path: configPath,
            drift
        },
        checks,
        ok: checks.every((item) => item.ok)
    };
}
function builderOptions(config) {
    return { ...config.builder, envAllowlist: config.safety.envAllowlist };
}
async function checkWorkspaceTempDir(workspacePath) {
    await fs.access(workspacePath);
    await ensureKaizenTempDir(workspacePath);
}
async function checkWorkspacePermissions(workspacePath, slug, repair) {
    const directories = [
        workspacePath,
        ...await existingWorktreeDirectories(workspacePath),
        ...await existingGuardianWorktreeDirectories(slug)
    ];
    for (const directory of directories) {
        if (repair)
            await makeDirectoryPrivate(directory);
        await assertPrivateDirectory(directory);
    }
}
async function existingGuardianWorktreeDirectories(slug) {
    const root = path.join(projectStateDir(slug), 'guardian', 'worktrees');
    try {
        return [root, ...await childDirectories(root)];
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
async function existingWorktreeDirectories(workspacePath) {
    const root = worktreesDirForWorkspace(workspacePath);
    let runDirectories;
    try {
        runDirectories = await childDirectories(root);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const worktrees = await Promise.all(runDirectories.map((directory) => childDirectories(directory)));
    return [root, ...runDirectories, ...worktrees.flat()];
}
async function childDirectories(parent) {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name));
}
function configuredAgents(config) {
    if (!config)
        return [];
    const agents = [config.agent.default];
    const fallback = config.agent.default === 'codex' ? 'claude' : 'codex';
    if (config.agent.fallback && !agents.includes(fallback))
        agents.push(fallback);
    return agents;
}
export function requiredLabels(config) {
    return [...new Set([
            config.issues.label,
            ...config.issues.priorityOrder,
            config.issues.selection.includeLabel,
            ...config.issues.selection.excludeLabels,
            'kaizen:direct',
            'kaizen:pr-only',
            'kaizen:in-progress',
            ...Object.values(DISPOSITION_LABELS),
            'kaizen:roadmap',
            config.goal.issueLabel,
            'kaizen:agent:claude',
            'kaizen:agent:codex'
        ])];
}
async function check(checks, name, fn) {
    try {
        await fn();
        checks.push({ name, ok: true });
    }
    catch (error) {
        checks.push({ name, ok: false, message: String(error) });
    }
}
//# sourceMappingURL=doctor.js.map