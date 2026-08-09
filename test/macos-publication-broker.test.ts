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
  let evidencePath: string;
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
    pidPath = path.join(root, 'supervisor.pid');
    sourceRepository = path.join(root, 'source.git');
    remoteRepository = path.join(root, 'remote.git');
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    for (const [source, output, cache] of [
      ['kaizen-publication-broker.swift', brokerPath, 'broker-cache'],
      ['kaizen-scheduled-launcher.swift', scheduledPath, 'scheduled-cache'],
      ['kaizen-supervisor-launcher.swift', supervisorPath, 'supervisor-cache']
    ]) {
      execFileSync('swiftc', [
        '-module-cache-path', path.join(root, cache),
        path.join(sourceRoot, 'scripts', 'macos', source),
        '-o', output
      ], { stdio: 'pipe' });
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
const { spawnSync } = require('node:child_process');
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
const preflight = () => request({ operation: 'preflight' });
(async () => {
  if (process.env.KAIZEN_BROKER_CHILD === '1') process.exit((await preflight()) ? 9 : 0);
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  const sleeping = process.argv.includes('sleep');
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
  fs.writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ supervisor, childRejected: child.status === 0, published }));
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
</dict></plist>\n`;
    await fs.writeFile(configPath, plist);
    broker = spawn(brokerPath, [configPath], {
      env: { ...process.env, KAIZEN_BROKER_TEST_CONFIG: configPath },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    await Promise.all([waitForPath(schedulerSocket), waitForPath(publicationSocket)]);
  }, 120_000);

  afterAll(async () => {
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM');
      await new Promise<void>((resolve) => broker.once('exit', () => resolve()));
    }
    await fs.rm(root, { recursive: true, force: true });
  }, 30_000);

  it('authenticates the broker-spawned supervisor and rejects its same-UID Node child', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(scheduledPath, ['ignored-node', 'o-r', 'maintenance'], {
        env: { ...process.env, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (error) => error ? reject(error) : resolve());
    });

    expect(JSON.parse(await fs.readFile(evidencePath, 'utf8'))).toEqual({
      supervisor: true,
      childRejected: true,
      published: false
    });
  });

  it('publishes the revalidated commit through the scheduled root-broker path', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(scheduledPath, ['ignored-node', 'o-r', 'publish'], {
        env: { ...process.env, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (error) => error ? reject(error) : resolve());
    });

    expect(JSON.parse(await fs.readFile(evidencePath, 'utf8'))).toEqual({
      supervisor: true,
      childRejected: true,
      published: true
    });
    expect(execFileSync('/usr/bin/git', [
      '--git-dir', remoteRepository, 'rev-parse', 'refs/heads/kaizen/test'
    ], { encoding: 'utf8' }).trim()).toBe(expectedSha);
  });

  it('treats scheduled-launcher disconnect as cancellation of the supervisor process group', async () => {
    await fs.rm(pidPath, { force: true });
    const launcher = spawn(scheduledPath, ['ignored-node', 'o-r', 'sleep'], {
      env: {
        ...process.env,
        KAIZEN_BROKER_TEST_CONFIG: configPath
      },
      stdio: 'ignore'
    });
    await waitForPath(pidPath);
    const supervisorPid = Number(await fs.readFile(pidPath, 'utf8'));
    launcher.kill('SIGTERM');
    await waitForExit(supervisorPid);
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
    expect(installer).toContain('install -o root -g wheel -m 0600 "$config_stage" "$config_path"');
    expect(installer).toContain('install -o root -g wheel -m 0644 "$daemon_stage" "$daemon_path"');
    expect(installer).toContain('cp -p "$build_dir/config.backup" "$config_path"');
    expect(installer).toContain('launchctl bootstrap system "$daemon_path"');
  });
});
