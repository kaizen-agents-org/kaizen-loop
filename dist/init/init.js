import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { defaultConfigObject } from '../config/config.js';
import { configSchema } from '../config/schema.js';
import { upsertProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import { hasSupervisorGitHubToken } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { getKaizenHome, workspaceDir } from '../utils/paths.js';
import { repoFromRemote, slugFromRepo } from '../utils/slug.js';
import { GitClient } from '../workspace/git.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { detectCommands } from './detect.js';
import { bundledProfilesDir, applySafetyFloor, loadProfile, mergeOverlay } from './profile.js';
import { issueTemplateYaml } from './templates.js';
export async function initProject(options) {
    const git = new GitClient(options.runCommand, options.cwd);
    const repoDir = await git.root();
    const remoteUrl = await git.remoteUrl('origin');
    const repo = repoFromRemote(remoteUrl);
    if (!repo)
        throw new ConfigError(`origin is not a GitHub remote: ${remoteUrl}`);
    const github = new GitHubClient(options.runCommand, repoDir);
    await github.authStatus();
    if (!hasSupervisorGitHubToken()) {
        throw new ConfigError('Set GH_TOKEN or GITHUB_TOKEN in the supervisor environment before initialization.');
    }
    const agent = chooseAgent(options.agent);
    const commands = await detectCommands(repoDir);
    const configPath = path.join(repoDir, '.kaizen', 'config.yml');
    const templatePath = path.join(repoDir, '.github', 'ISSUE_TEMPLATE', 'kaizen.yml');
    let config = await createInitialConfig({ agent, schedule: options.schedule, ...commands });
    let profileName;
    let corrections = [];
    if (options.profile) {
        const overlay = await loadProfile(options.profile, options.profilesDir ?? bundledProfilesDir());
        profileName = overlay.name;
        config = mergeOverlay(config, overlay.values);
    }
    const floored = applySafetyFloor(config);
    config = floored.config;
    corrections = floored.corrections;
    // Validate before any write or external side effect. A profile can carry a
    // schema-invalid override, and without this init would create labels, a
    // workspace, and a registry entry, report success, and leave every later
    // command rejecting the config it just wrote.
    try {
        configSchema.parse(config);
    }
    catch (error) {
        const source = profileName ? `profile "${profileName}"` : 'generated configuration';
        throw new ConfigError(`The ${source} produces an invalid .kaizen/config.yml; nothing was written: ${String(error)}`);
    }
    await writeFileOnce(configPath, stringify(config), options.yes);
    await writeFileOnce(templatePath, issueTemplateYaml(), options.yes);
    await github.createLabels();
    const slug = slugFromRepo(repo);
    const workspacePath = workspaceDir(slug);
    const workspace = new WorkspaceManager(options.runCommand, workspacePath, remoteUrl);
    await workspace.ensure();
    await upsertProject(slug, {
        repo,
        localPath: repoDir,
        workspacePath,
        schedule: options.schedule,
        enabled: false,
        createdAt: new Date().toISOString()
    });
    return { slug, repo, configPath, profile: profileName, safetyFloorCorrections: corrections };
}
export async function createInitialConfig(options, kaizenHome = getKaizenHome()) {
    const expectedVerifierRef = await readInstalledVerifierRef(kaizenHome);
    return defaultConfigObject({ ...options, expectedVerifierRef });
}
export async function readInstalledVerifierRef(kaizenHome = getKaizenHome()) {
    const stamp = path.join(kaizenHome, 'toolchain', 'verifier', '.installed-version');
    let version;
    try {
        version = (await fs.readFile(stamp, 'utf8')).trim();
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw new ConfigError(`Unable to read installed Verifier version at ${stamp}: ${String(error)}`);
    }
    if (!/^v0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new ConfigError(`Invalid installed Verifier version at ${stamp}: expected one v0.x.y release tag.`);
    }
    return `refs/tags/${version}`;
}
function chooseAgent(preferred) {
    return preferred ?? 'claude';
}
async function writeFileOnce(filePath, content, overwrite) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
        await fs.writeFile(filePath, content, { flag: overwrite ? 'w' : 'wx' });
    }
    catch (error) {
        if (error.code === 'EEXIST') {
            throw new ConfigError(`${filePath} already exists. Re-run with --yes to overwrite.`);
        }
        throw error;
    }
}
//# sourceMappingURL=init.js.map