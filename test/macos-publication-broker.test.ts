import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let nativeSwiftAvailable = false;
if (process.platform === 'darwin') {
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-swift-probe-'));
  try {
    const probe = path.join(probeRoot, 'probe.swift');
    await fs.writeFile(probe, 'import Foundation\nprint("ok")\n');
    execFileSync('swiftc', ['-module-cache-path', path.join(probeRoot, 'cache'), probe, '-o', path.join(probeRoot, 'probe')], {
      stdio: 'pipe'
    });
    nativeSwiftAvailable = true;
  } catch {
    nativeSwiftAvailable = false;
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true });
  }
}
const macTest = nativeSwiftAvailable ? describe : describe.skip;
if (process.env.KAIZEN_REQUIRE_NATIVE_BROKER_TESTS === '1' && !nativeSwiftAvailable) {
  throw new Error('A working macOS Swift/Foundation toolchain is required for publication broker tests.');
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function waitForPath(candidate: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await fs.access(candidate); return; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error(`Timed out waiting for ${candidate}`);
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit after launcher disconnect`);
}

macTest('macOS publication broker', { timeout: 180_000 }, () => {
  let root: string;
  let brokerPath: string;
  let scheduledPath: string;
  let supervisorPath: string;
  let configPath: string;
  let schedulerSocket: string;
  let publicationSocket: string;
  let broker: ChildProcess;
  let brokerStderr = '';
  let evidencePath: string;
  let scheduledToolPath: string;
  let pidPath: string;
  let sourceRepository: string;
  let remoteRepository: string;
  let expectedSha: string;

  beforeAll(async () => {
    root = await fs.mkdtemp('/private/tmp/kaizen-broker-test-');
    brokerPath = path.join(root, 'kaizen-publication-broker');
    scheduledPath = path.join(root, 'kaizen-scheduled-launcher');
    supervisorPath = path.join(root, 'kaizen-supervisor-launcher');
    configPath = path.join(root, 'publication-broker.plist');
    schedulerSocket = path.join(root, 'scheduler.sock');
    publicationSocket = path.join(root, 'publication.sock');
    evidencePath = path.join(root, 'evidence.json');
    scheduledToolPath = `${path.join(root, 'tools')}:/usr/bin:/bin`;
    pidPath = path.join(root, 'supervisor.pid');
    sourceRepository = path.join(root, 'source.git');
    remoteRepository = path.join(root, 'remote.git');
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    for (const [source, output, cache] of [
      ['kaizen-publication-broker.swift', brokerPath, 'broker-cache'],
      ['kaizen-scheduled-launcher.swift', scheduledPath, 'scheduled-cache'],
      ['kaizen-supervisor-launcher.swift', supervisorPath, 'supervisor-cache']
    ]) {
      try {
        execFileSync('swiftc', [
          '-module-cache-path', path.join(root, cache),
          path.join(sourceRoot, 'scripts', 'macos', source),
          '-o', output
        ], { stdio: 'pipe' });
      } catch (error) {
        const details = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
        throw new Error(`swiftc failed for ${source}:\n${details}`);
      }
    }

    const workRepository = path.join(root, 'work');
    execFileSync('/usr/bin/git', ['init', workRepository], { stdio: 'pipe' });
    execFileSync('/usr/bin/git', ['-C', workRepository, 'config', 'user.name', 'Kaizen Test'], { stdio: 'pipe' });
    execFileSync('/usr/bin/git', ['-C', workRepository, 'config', 'user.email', 'kaizen@example.invalid'], { stdio: 'pipe' });
    await fs.writeFile(path.join(workRepository, 'result.txt'), 'published\n');
    execFileSync('/usr/bin/git', ['-C', workRepository, 'add', 'result.txt'], { stdio: 'pipe' });
    execFileSync('/usr/bin/git', ['-C', workRepository, 'commit', '-m', 'test publication'], { stdio: 'pipe' });
    execFileSync('/usr/bin/git', ['-C', workRepository, 'branch', '-M', 'kaizen/test'], { stdio: 'pipe' });
    expectedSha = execFileSync('/usr/bin/git', ['-C', workRepository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('/usr/bin/git', ['clone', '--bare', workRepository, sourceRepository], { stdio: 'pipe' });
    execFileSync('/usr/bin/git', ['init', '--bare', remoteRepository], { stdio: 'pipe' });

    const fixturePath = path.join(root, 'supervisor.cjs');
    await fs.writeFile(fixturePath, `
const fs = require('node:fs');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const socketPath = process.env.KAIZEN_GITHUB_TOKEN_SOCKET;
const capability = process.env.KAIZEN_GITHUB_BROKER_CAPABILITY;
function request(payload) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ version: 1, capability, ...payload }) + '\\n'));
    socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve(JSON.parse(output).ok === true));
    socket.on('error', () => resolve(false));
  });
}
const preflight = () => request({
  operation: 'preflight',
  pushUrl: ${JSON.stringify(`file://${remoteRepository}`)},
  expectedRepo: 'o/r'
});
(async () => {
  if (process.env.KAIZEN_BROKER_CHILD === '1') process.exit((await preflight()) ? 9 : 0);
  const sleeping = process.argv.includes('sleep');
  const descendant = sleeping
    ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    : undefined;
  fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ supervisor: process.pid, descendant: descendant?.pid }));
  if (sleeping) setInterval(() => {}, 1000);
  const supervisor = await preflight();
  const child = spawnSync(process.execPath, [__filename], { env: { ...process.env, KAIZEN_BROKER_CHILD: '1' } });
  let published = false;
  if (process.argv.includes('publish')) {
    published = await request({
      operation: 'git-push',
      cwd: ${JSON.stringify(sourceRepository)},
      pushUrl: ${JSON.stringify(`file://${remoteRepository}`)},
      refspec: 'kaizen/test:refs/heads/kaizen/test',
      expectedRepo: 'o/r',
      expectedSha: ${JSON.stringify(expectedSha)}
    });
  }
  fs.writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ supervisor, childRejected: child.status === 0, published, toolPath: process.env.PATH }));
  if (sleeping) return;
  process.exit(supervisor && child.status === 0 && (!process.argv.includes('publish') || published) ? 0 : 1);
})().catch(() => process.exit(1));
`);
    await fs.writeFile(path.join(root, 'token'), 'test-token\n', { mode: 0o600 });
    const user = os.userInfo();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>runtimeUser</key><string>${xml(user.username)}</string>
<key>runtimeUid</key><integer>${process.getuid!()}</integer>
<key>runtimeGid</key><integer>${process.getgid!()}</integer>
<key>runtimeHome</key><string>${xml(user.homedir)}</string>
<key>schedulerSocketPath</key><string>${xml(schedulerSocket)}</string>
<key>publicationSocketPath</key><string>${xml(publicationSocket)}</string>
<key>scheduledLauncherExecutable</key><string>${xml(scheduledPath)}</string>
<key>supervisorLauncherExecutable</key><string>${xml(supervisorPath)}</string>
<key>nodeExecutable</key><string>${xml(process.execPath)}</string>
<key>gitExecutable</key><string>/usr/bin/git</string>
<key>cliPath</key><string>${xml(fixturePath)}</string>
<key>tokenFile</key><string>${xml(path.join(root, 'token'))}</string>
<key>privateDirectory</key><string>${xml(path.join(root, 'private'))}</string>
<key>allowedRepositories</key><dict><key>o/r</key><string>${xml(`file://${remoteRepository}`)}</string></dict>
<key>scheduledJobs</key><array>
<dict><key>project</key><string>o-r</string><key>job</key><string>maintenance</string><key>toolPath</key><string>${xml(scheduledToolPath)}</string></dict>
<dict><key>project</key><string>o-r</string><key>job</key><string>publish</string><key>toolPath</key><string>${xml(scheduledToolPath)}</string></dict>
<dict><key>project</key><string>o-r</string><key>job</key><string>sleep</string><key>toolPath</key><string>${xml(scheduledToolPath)}</string></dict>
</array>
</dict></plist>\n`;
    await fs.writeFile(configPath, plist);
    broker = spawn(brokerPath, [configPath], {
      env: { ...process.env, KAIZEN_BROKER_TEST_CONFIG: configPath },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    broker.stderr?.setEncoding('utf8');
    broker.stderr?.on('data', (chunk: string) => { brokerStderr += chunk; });
    await Promise.all([waitForPath(schedulerSocket), waitForPath(publicationSocket)]);
  }, 120_000);

  afterAll(async () => {
    if (broker && broker.exitCode === null) {
      let resolveExited!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExited = resolve;
        broker.once('exit', resolve);
      });
      if (broker.exitCode === null) broker.kill('SIGTERM');
      else resolveExited();
      const escalation = setTimeout(() => {
        if (broker.exitCode === null) broker.kill('SIGKILL');
      }, 5_000);
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      ]);
      clearTimeout(escalation);
    }
    await fs.rm(root, { recursive: true, force: true });
  }, 30_000);

  it('authenticates the broker-spawned supervisor and rejects its same-UID Node child', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(scheduledPath, ['ignored-node', 'o-r', 'maintenance'], {
        env: { ...process.env, PATH: scheduledToolPath, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (error) => error ? reject(new Error(`${error.message}\n${brokerStderr}`)) : resolve());
    });

    expect(JSON.parse(await fs.readFile(evidencePath, 'utf8'))).toEqual({
      supervisor: true,
      childRejected: true,
      published: false,
      toolPath: scheduledToolPath
    });
  });

  it('publishes the revalidated commit through the scheduled root-broker path', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(scheduledPath, ['ignored-node', 'o-r', 'publish'], {
        env: { ...process.env, PATH: scheduledToolPath, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (error) => error ? reject(new Error(`${error.message}\n${brokerStderr}`)) : resolve());
    });

    expect(JSON.parse(await fs.readFile(evidencePath, 'utf8'))).toEqual({
      supervisor: true,
      childRejected: true,
      published: true,
      toolPath: scheduledToolPath
    });
    expect(execFileSync('/usr/bin/git', [
      '--git-dir', remoteRepository, 'rev-parse', 'refs/heads/kaizen/test'
    ], { encoding: 'utf8' }).trim()).toBe(expectedSha);
  });

  it('rejects a same-UID launcher request absent from the root-owned job registration', async () => {
    const error = await new Promise<Error | null>((resolve) => {
      execFile(scheduledPath, ['ignored-node', 'o-r', 'unconfigured'], {
        env: { ...process.env, PATH: scheduledToolPath, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (failure) => resolve(failure));
    });
    expect(error).not.toBeNull();
  });

  it('treats scheduled-launcher disconnect as cancellation of the supervisor process group', async () => {
    await fs.rm(pidPath, { force: true });
    const launcher = spawn(scheduledPath, ['ignored-node', 'o-r', 'sleep'], {
      env: {
        ...process.env,
        PATH: scheduledToolPath,
        KAIZEN_BROKER_TEST_CONFIG: configPath
      },
      stdio: 'ignore'
    });
    await waitForPath(pidPath);
    const pids = JSON.parse(await fs.readFile(pidPath, 'utf8')) as { supervisor: number; descendant: number };
    launcher.kill('SIGTERM');
    await Promise.all([waitForExit(pids.supervisor), waitForExit(pids.descendant)]);
  });

});

describe('publication broker source contract', () => {
  it('keeps wire responses boolean-only and installer credentials root-only', async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    const brokerSource = await fs.readFile(path.join(sourceRoot, 'scripts/macos/kaizen-publication-broker.swift'), 'utf8');
    const installer = await fs.readFile(path.join(sourceRoot, 'scripts/install-macos-publication-broker.sh'), 'utf8');
    expect(brokerSource).toContain('{\\"ok\\":true}');
    expect(brokerSource).toContain('{\\"ok\\":false}');
    expect(brokerSource).not.toMatch(/response.*error|error.*response/i);
    expect(installer).toContain('token file mode must be 0600');
    expect(installer).not.toMatch(/cat .*token_file|echo .*token_file/);
    expect(installer).toContain('Refusing to replace an installation without the Kaizen publication broker marker');
    expect(installer).toContain('install -o root -g wheel -m 0644 "$config_stage" "$config_path"');
    expect(installer).toContain('install -o root -g wheel -m 0644 "$daemon_stage" "$daemon_path"');
    expect(installer).toContain('chmod 0755 "$config_dir"');
    expect(brokerSource).toContain('chown(config.privateDirectory, 0, config.runtimeGid)');
    expect(brokerSource).toContain('chmod(config.privateDirectory, 0o710)');
    expect(brokerSource).toContain('processPath(pid) == config.scheduledLauncherExecutable');
    expect(brokerSource).toContain('parentPid(pid) == 1 && processPath(1) == "/sbin/launchd"');
    expect(brokerSource).toContain('mode: 0o620');
    expect(brokerSource).toContain('config.scheduledJobs.first');
    expect(brokerSource).toContain('POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT');
    expect(brokerSource).toContain('kill(-process.processIdentifier, signal)');
    expect(installer).toContain('Add :schedulerSocketPath string /opt/kaizen/run/scheduler.sock');
    expect(installer).toContain('Add :publicationSocketPath string /opt/kaizen/run/publication.sock');
    expect(installer).toContain('cp -p "$build_dir/config.backup" "$config_path"');
    expect(installer).toContain('launchctl bootstrap system "$daemon_path"');
  });
});
