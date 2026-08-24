import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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
  let githubCliPath: string;
  let githubAppServer: Server;
  let githubAppApiBaseUrl: string;
  let githubAppTokenRequests = 0;
  let githubAppTokensIssued = 0;
  let githubAppPrivateKeyPath: string;
  let githubAppPkcs1PrivateKeyPath: string;
  let githubAppResponseMode: 'success' | 'redirect' = 'success';
  let githubAppRedirectTargetRequests = 0;

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
    githubCliPath = path.join(root, 'github-cli.cjs');
    await fs.writeFile(githubCliPath, `#!${process.execPath}\nif (process.argv.includes('__signal__')) process.kill(process.pid, 'SIGTERM');\nprocess.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN, repo: process.env.GH_REPO, config: process.env.GH_CONFIG_DIR, cwd: process.cwd() }));\n`, { mode: 0o755 });

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    githubAppPrivateKeyPath = path.join(root, 'github-app-private-key.pem');
    githubAppPkcs1PrivateKeyPath = path.join(root, 'github-app-private-key-pkcs1.pem');
    await fs.writeFile(githubAppPrivateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await fs.writeFile(githubAppPkcs1PrivateKeyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
    githubAppServer = createServer((request, response) => {
      if (request.url === '/redirect-target') {
        githubAppRedirectTargetRequests += 1;
        response.writeHead(500).end();
        return;
      }
      const authorization = request.headers.authorization ?? '';
      const jwt = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
      const parts = jwt.split('.');
      let valid = false;
      if (request.method === 'POST' && request.url === '/app/installations/67890/access_tokens' && parts.length === 3) {
        const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { iss?: number; iat?: number; exp?: number };
        const now = Math.floor(Date.now() / 1000);
        valid = claims.iss === 12345 && typeof claims.iat === 'number' && claims.iat <= now &&
          typeof claims.exp === 'number' && claims.exp > now && claims.exp <= now + 600 &&
          verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'));
      }
      if (!valid) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"message":"invalid app jwt"}');
        return;
      }
      githubAppTokenRequests += 1;
      if (githubAppResponseMode === 'redirect') {
        response.writeHead(302, { location: '/redirect-target' });
        response.end();
        return;
      }
      githubAppTokensIssued += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        token: 'installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }));
    });
    await new Promise<void>((resolve, reject) => {
      githubAppServer.once('error', reject);
      githubAppServer.listen(0, '127.0.0.1', resolve);
    });
    const address = githubAppServer.address();
    if (!address || typeof address === 'string') throw new Error('GitHub App test server did not bind a TCP port');
    githubAppApiBaseUrl = `http://127.0.0.1:${address.port}`;

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
    socket.on('end', () => resolve(JSON.parse(output)));
    socket.on('error', () => resolve({ ok: false }));
  });
}
const preflight = async () => (await request({
  operation: 'preflight',
  pushUrl: ${JSON.stringify(`file://${remoteRepository}`)},
  expectedRepo: 'o/r'
})).ok === true;
const github = () => request({
  operation: 'github-cli',
  args: ['api', 'user'],
  cwd: '/untrusted/workspace',
  input: '',
  timeoutMs: 10000,
  maxOutputBytes: 65536
});
(async () => {
  if (process.env.KAIZEN_BROKER_CHILD === '1') {
    const githubResult = await github();
    process.exit(process.env.GH_TOKEN === undefined && !(await preflight()) && githubResult.ok !== true ? 0 : 9);
  }
  const sleeping = process.argv.includes('sleep');
  const descendant = sleeping
    ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    : undefined;
  fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ supervisor: process.pid, descendant: descendant?.pid }));
  if (sleeping) setInterval(() => {}, 1000);
  const supervisor = await preflight();
  const githubResult = await github();
  const githubEvidence = githubResult.ok === true
    ? JSON.parse(Buffer.from(githubResult.stdoutBase64, 'base64').toString('utf8'))
    : {};
  const tokenCommandRefused = (await request({
    operation: 'github-cli',
    args: ['auth', 'token'],
    cwd: '/untrusted/workspace',
    input: '',
    timeoutMs: 10000,
    maxOutputBytes: 65536
  })).ok !== true;
  const mismatchedRepoRefused = (await request({
    operation: 'github-cli', args: ['issue', 'view', '1', '--repo', 'o/r', '--repo', 'other/repo'], cwd: '/untrusted/workspace',
    input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok !== true;
  const hostileHostnameRefused = (await request({
    operation: 'github-cli', args: ['api', 'user', '--hostname', 'example.invalid'], cwd: '/untrusted/workspace',
    input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok !== true;
  const crossRepoApiRefused = (await request({
    operation: 'github-cli', args: ['api', 'repos/other/repo/issues'], cwd: '/untrusted/workspace',
    input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok !== true;
  const crossRepoGraphqlRefused = (await request({
    operation: 'github-cli',
    args: ['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}', '-F', 'owner=other', '-F', 'name=repo'],
    cwd: '/untrusted/workspace', input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok !== true;
  const unsupportedCommandRefused = (await request({
    operation: 'github-cli', args: ['repo', 'clone', 'other/repo'], cwd: '/untrusted/workspace',
    input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok !== true;
  const registeredGraphqlAllowed = (await request({
    operation: 'github-cli',
    args: ['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}', '-F', 'owner=o', '-F', 'name=r'],
    cwd: '/untrusted/workspace', input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok === true;
  const ownerSearchAllowed = (await request({
    operation: 'github-cli',
    args: ['api', 'graphql', '-f', 'query=query($searchQuery:String!){search(query:$searchQuery,type:ISSUE,first:10){nodes{... on PullRequest{number}}}}', '-F', 'searchQuery=is:pr is:open owner:o'],
    cwd: '/untrusted/workspace', input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok === true;
  const extraGraphqlRootRefused = (await request({
    operation: 'github-cli',
    args: ['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id} viewer{login}}', '-F', 'owner=o', '-F', 'name=r'],
    cwd: '/untrusted/workspace', input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok !== true;
  const localBodyFileRefused = (await request({
    operation: 'github-cli', args: ['issue', 'create', '--body-file', '/etc/passwd'], cwd: '/untrusted/workspace',
    input: '', timeoutMs: 10000, maxOutputBytes: 65536
  })).ok !== true;
  const signaledResult = await request({
    operation: 'github-cli', args: ['api', 'user', '--jq', '__signal__'], cwd: '/untrusted/workspace',
    input: '', timeoutMs: 10000, maxOutputBytes: 65536
  });
  const child = spawnSync(process.execPath, [__filename], { env: { ...process.env, KAIZEN_BROKER_CHILD: '1' } });
  let published = false;
  if (process.argv.includes('publish')) {
    published = (await request({
      operation: 'git-push',
      cwd: ${JSON.stringify(sourceRepository)},
      pushUrl: ${JSON.stringify(`file://${remoteRepository}`)},
      refspec: 'kaizen/test:refs/heads/kaizen/test',
      expectedRepo: 'o/r',
      expectedSha: ${JSON.stringify(expectedSha)}
    })).ok === true;
  }
  fs.writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ supervisor, childRejected: child.status === 0, published, runtimeTokenAbsent: process.env.GH_TOKEN === undefined, tokenCommandRefused, mismatchedRepoRefused, hostileHostnameRefused, crossRepoApiRefused, crossRepoGraphqlRefused, unsupportedCommandRefused, registeredGraphqlAllowed, ownerSearchAllowed, extraGraphqlRootRefused, localBodyFileRefused, signaledExitCode: signaledResult.exitCode, githubEvidence, ghConfigDir: process.env.GH_CONFIG_DIR, kaizenHome: process.env.KAIZEN_HOME, toolPath: process.env.PATH, publicationTimeout: process.env.KAIZEN_GITHUB_PUBLICATION_TIMEOUT_MS }));
  if (sleeping) return;
  process.exit(supervisor && child.status === 0 && (!process.argv.includes('publish') || published) ? 0 : 1);
})().catch(() => process.exit(1));
`);
    const user = os.userInfo();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>runtimeUser</key><string>${xml(user.username)}</string>
<key>runtimeUid</key><integer>${process.getuid!()}</integer>
<key>runtimeGid</key><integer>${process.getgid!()}</integer>
<key>runtimeHome</key><string>${xml(user.homedir)}</string>
<key>kaizenHome</key><string>${xml(path.join(root, 'custom-kaizen-home'))}</string>
<key>schedulerSocketPath</key><string>${xml(schedulerSocket)}</string>
<key>publicationSocketPath</key><string>${xml(publicationSocket)}</string>
<key>scheduledLauncherExecutable</key><string>${xml(scheduledPath)}</string>
<key>supervisorLauncherExecutable</key><string>${xml(supervisorPath)}</string>
<key>nodeExecutable</key><string>${xml(process.execPath)}</string>
<key>gitExecutable</key><string>/usr/bin/git</string>
<key>githubCliExecutable</key><string>${xml(githubCliPath)}</string>
<key>cliPath</key><string>${xml(fixturePath)}</string>
<key>githubAppId</key><integer>12345</integer>
<key>githubAppInstallationId</key><integer>67890</integer>
<key>githubAppPrivateKeyFile</key><string>${xml(githubAppPrivateKeyPath)}</string>
<key>githubAppApiBaseUrl</key><string>${xml(githubAppApiBaseUrl)}</string>
<key>privateDirectory</key><string>${xml(path.join(root, 'private'))}</string>
<key>allowedRepositories</key><dict><key>o/r</key><string>${xml(`file://${remoteRepository}`)}</string></dict>
<key>scheduledJobs</key><array>
<dict><key>project</key><string>o-r</string><key>job</key><string>maintenance</string><key>toolPath</key><string>${xml(scheduledToolPath)}</string><key>hour</key><integer>2</integer><key>minute</key><integer>0</integer><key>publicationTimeoutMs</key><integer>1800000</integer></dict>
<dict><key>project</key><string>o-r</string><key>job</key><string>publish</string><key>toolPath</key><string>${xml(scheduledToolPath)}</string><key>hour</key><integer>2</integer><key>minute</key><integer>0</integer><key>publicationTimeoutMs</key><integer>1800000</integer></dict>
<dict><key>project</key><string>o-r</string><key>job</key><string>sleep</string><key>toolPath</key><string>${xml(scheduledToolPath)}</string><key>hour</key><integer>2</integer><key>minute</key><integer>0</integer><key>publicationTimeoutMs</key><integer>1800000</integer></dict>
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
  }, 300_000);

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
    if (githubAppServer) await new Promise<void>((resolve) => githubAppServer.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }, 30_000);

  it('advertises the root-only production dispatch and canary commands', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(scheduledPath, ['--help'], (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    expect(output.trim()).toBe('usage: kaizen-scheduled-launcher dispatch | canary <project> <job>');
  });

  it('authenticates the broker-spawned supervisor and rejects its same-UID Node child', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(scheduledPath, ['canary', 'o-r', 'maintenance'], {
        env: { ...process.env, PATH: scheduledToolPath, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (error) => error ? reject(new Error(`${error.message}\n${brokerStderr}`)) : resolve());
    });

    expect(JSON.parse(await fs.readFile(evidencePath, 'utf8'))).toEqual({
      supervisor: true,
      childRejected: true,
      published: false,
      runtimeTokenAbsent: true,
      tokenCommandRefused: true,
      mismatchedRepoRefused: true,
      hostileHostnameRefused: true,
      crossRepoApiRefused: true,
      crossRepoGraphqlRefused: true,
      unsupportedCommandRefused: true,
      registeredGraphqlAllowed: true,
      ownerSearchAllowed: true,
      extraGraphqlRootRefused: true,
      localBodyFileRefused: true,
      signaledExitCode: 143,
      githubEvidence: { token: 'installation-token', repo: 'o/r', config: '/var/empty', cwd: '/private/var/empty' },
      ghConfigDir: '/var/empty',
      kaizenHome: path.join(root, 'custom-kaizen-home'),
      toolPath: scheduledToolPath,
      publicationTimeout: '1800000'
    });
  });

  it('publishes the revalidated commit through the scheduled root-broker path', async () => {
    const tokensIssuedBeforePublication = githubAppTokensIssued;
    await new Promise<void>((resolve, reject) => {
      execFile(scheduledPath, ['canary', 'o-r', 'publish'], {
        env: { ...process.env, PATH: scheduledToolPath, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (error) => error ? reject(new Error(`${error.message}\n${brokerStderr}`)) : resolve());
    });

    expect(JSON.parse(await fs.readFile(evidencePath, 'utf8'))).toEqual({
      supervisor: true,
      childRejected: true,
      published: true,
      runtimeTokenAbsent: true,
      tokenCommandRefused: true,
      mismatchedRepoRefused: true,
      hostileHostnameRefused: true,
      crossRepoApiRefused: true,
      crossRepoGraphqlRefused: true,
      unsupportedCommandRefused: true,
      registeredGraphqlAllowed: true,
      ownerSearchAllowed: true,
      extraGraphqlRootRefused: true,
      localBodyFileRefused: true,
      signaledExitCode: 143,
      githubEvidence: { token: 'installation-token', repo: 'o/r', config: '/var/empty', cwd: '/private/var/empty' },
      ghConfigDir: '/var/empty',
      kaizenHome: path.join(root, 'custom-kaizen-home'),
      toolPath: scheduledToolPath,
      publicationTimeout: '1800000'
    });
    expect(execFileSync('/usr/bin/git', [
      '--git-dir', remoteRepository, 'rev-parse', 'refs/heads/kaizen/test'
    ], { encoding: 'utf8' }).trim()).toBe(expectedSha);
    expect(githubAppTokensIssued - tokensIssuedBeforePublication).toBe(1);
  });

  it('rejects a same-UID launcher request absent from the root-owned job registration', async () => {
    const error = await new Promise<Error | null>((resolve) => {
      execFile(scheduledPath, ['canary', 'o-r', 'unconfigured'], {
        env: { ...process.env, PATH: scheduledToolPath, KAIZEN_BROKER_TEST_CONFIG: configPath }
      }, (failure) => resolve(failure));
    });
    expect(error).not.toBeNull();
  });

  it('treats scheduled-launcher disconnect as cancellation of the supervisor process group', async () => {
    await fs.rm(pidPath, { force: true });
    const launcher = spawn(scheduledPath, ['canary', 'o-r', 'sleep'], {
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

  it('starts with the legacy static-token mode and PKCS#1 GitHub App keys', async () => {
    const original = await fs.readFile(configPath, 'utf8');
    const variants = [
      {
        name: 'static',
        auth: `<key>tokenFile</key><string>${xml(path.join(root, 'static-token'))}</string>`,
        prepare: () => fs.writeFile(path.join(root, 'static-token'), 'static-token\n', { mode: 0o600 })
      },
      {
        name: 'pkcs1',
        auth: `<key>githubAppId</key><integer>12345</integer>\n<key>githubAppInstallationId</key><integer>67890</integer>\n<key>githubAppPrivateKeyFile</key><string>${xml(githubAppPkcs1PrivateKeyPath)}</string>\n<key>githubAppApiBaseUrl</key><string>${xml(githubAppApiBaseUrl)}</string>`,
        prepare: async () => undefined
      }
    ];
    for (const variant of variants) {
      await variant.prepare();
      const variantConfig = path.join(root, `${variant.name}-publication-broker.plist`);
      const variantSchedulerSocket = path.join(root, `${variant.name}-scheduler.sock`);
      const variantPublicationSocket = path.join(root, `${variant.name}-publication.sock`);
      const appAuth = `<key>githubAppId</key><integer>12345</integer>\n<key>githubAppInstallationId</key><integer>67890</integer>\n<key>githubAppPrivateKeyFile</key><string>${xml(githubAppPrivateKeyPath)}</string>\n<key>githubAppApiBaseUrl</key><string>${xml(githubAppApiBaseUrl)}</string>`;
      const authContents = original.replace(appAuth, variant.auth);
      expect(authContents).not.toBe(original);
      expect(authContents).toContain(variant.auth);
      const contents = authContents
        .replace(`<key>schedulerSocketPath</key><string>${xml(schedulerSocket)}</string>`, `<key>schedulerSocketPath</key><string>${xml(variantSchedulerSocket)}</string>`)
        .replace(`<key>publicationSocketPath</key><string>${xml(publicationSocket)}</string>`, `<key>publicationSocketPath</key><string>${xml(variantPublicationSocket)}</string>`);
      await fs.writeFile(variantConfig, contents);
      const variantBroker = spawn(brokerPath, [variantConfig], {
        env: { ...process.env, KAIZEN_BROKER_TEST_CONFIG: variantConfig },
        stdio: 'ignore'
      });
      const variantExited = new Promise<void>((resolve) => variantBroker.once('exit', () => resolve()));
      try {
        await Promise.all([waitForPath(variantSchedulerSocket), waitForPath(variantPublicationSocket)]);
      } finally {
        if (variantBroker.exitCode === null) variantBroker.kill('SIGTERM');
        await variantExited;
      }
    }
  });

  it('does not forward the App JWT across redirects', async () => {
    const redirectConfig = path.join(root, 'redirect-publication-broker.plist');
    const redirectSchedulerSocket = path.join(root, 'redirect-scheduler.sock');
    const redirectPublicationSocket = path.join(root, 'redirect-publication.sock');
    const original = await fs.readFile(configPath, 'utf8');
    await fs.writeFile(redirectConfig, original
      .replace(`<key>schedulerSocketPath</key><string>${xml(schedulerSocket)}</string>`, `<key>schedulerSocketPath</key><string>${xml(redirectSchedulerSocket)}</string>`)
      .replace(`<key>publicationSocketPath</key><string>${xml(publicationSocket)}</string>`, `<key>publicationSocketPath</key><string>${xml(redirectPublicationSocket)}</string>`));
    githubAppResponseMode = 'redirect';
    const redirectBroker = spawn(brokerPath, [redirectConfig], {
      env: { ...process.env, KAIZEN_BROKER_TEST_CONFIG: redirectConfig },
      stdio: 'ignore'
    });
    try {
      await Promise.all([waitForPath(redirectSchedulerSocket), waitForPath(redirectPublicationSocket)]);
      const tokenRequestsBeforeRedirect = githubAppTokenRequests;
      await new Promise<void>((resolve, reject) => {
        execFile(scheduledPath, ['canary', 'o-r', 'maintenance'], {
          env: { ...process.env, PATH: scheduledToolPath, KAIZEN_BROKER_TEST_CONFIG: redirectConfig }
        }, (error) => error ? reject(error) : resolve());
      });
      expect(githubAppTokenRequests - tokenRequestsBeforeRedirect).toBeGreaterThan(0);
      expect(githubAppRedirectTargetRequests).toBe(0);
    } finally {
      githubAppResponseMode = 'success';
      redirectBroker.kill('SIGTERM');
      await new Promise<void>((resolve) => redirectBroker.once('exit', () => resolve()));
    }
  });

});

describe('publication broker source contract', () => {
  it('rejects malformed Verifier provenance before installation', async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    const installer = await fs.readFile(path.join(sourceRoot, 'scripts/install-macos-publication-broker.sh'), 'utf8');
    const startMarker = `| "$node_executable" -e '\n`;
    const start = installer.indexOf(startMarker);
    const end = installer.indexOf(`\n'; then`, start + startMarker.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const validator = installer.slice(start + startMarker.length, end);
    const valid = {
      name: 'verifier',
      version: '1.2.3',
      status: 'current',
      stale: false,
      build: { commit: 'a'.repeat(40), builtAt: '2026-08-24T00:00:00Z', dirty: false },
      runtime: { commit: 'a'.repeat(40), dirty: false, packageRoot: '/opt/verifier/packages/core' }
    };
    const accepts = (value: unknown) => {
      try {
        execFileSync(process.execPath, ['-e', validator], { input: JSON.stringify(value), stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    };

    expect(accepts(valid)).toBe(true);
    expect(accepts({ ...valid, status: 'legacy' })).toBe(false);
    expect(accepts({ ...valid, stale: null })).toBe(false);
    expect(accepts({ ...valid, version: 1 })).toBe(false);
    expect(accepts({ ...valid, build: { ...valid.build, dirty: 'false' } })).toBe(false);
    expect(accepts({ ...valid, runtime: { ...valid.runtime, packageRoot: {} } })).toBe(false);
  });

  it('keeps credentials root-only and broker responses bounded', async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    const brokerSource = await fs.readFile(path.join(sourceRoot, 'scripts/macos/kaizen-publication-broker.swift'), 'utf8');
    const supervisorSource = await fs.readFile(path.join(sourceRoot, 'scripts/macos/kaizen-supervisor-launcher.swift'), 'utf8');
    const scheduledSource = await fs.readFile(path.join(sourceRoot, 'scripts/macos/kaizen-scheduled-launcher.swift'), 'utf8');
    const installer = await fs.readFile(path.join(sourceRoot, 'scripts/install-macos-publication-broker.sh'), 'utf8');
    expect(brokerSource).toContain('{\\"ok\\":true}');
    expect(brokerSource).toContain('{\\"ok\\":false}');
    expect(brokerSource).toContain('maximumGitHubOutputBytes');
    expect(installer).toContain('credential_label="token file"');
    expect(installer).toContain('credential_label="GitHub App private key file"');
    expect(installer).toContain('--github-app-installation-id <id>');
    expect(installer).not.toMatch(/cat .*token_file|echo .*token_file/);
    expect(installer).toContain('Refusing to replace an installation without the Kaizen publication broker marker');
    expect(installer).toContain('install -o root -g wheel -m 0644 "$config_stage" "$config_path"');
    expect(installer).toContain('install -o root -g wheel -m 0644 "$daemon_stage" "$daemon_path"');
    expect(installer).toContain('chmod 0755 "$config_dir"');
    expect(installer).toContain('private_root=/var/db/kaizen-loop');
    expect(installer).toContain('private_directory="$private_root/publication"');
    expect(installer).toContain('install -d -o root -g wheel -m 0711 "$private_root"');
    expect(installer).toContain('chmod 0711 "$private_root"');
    expect(installer).toContain('[ -L "$private_root" ]');
    expect(installer).toContain('stat -f %Sg "$private_root"');
    expect(installer).toContain('stat -f %Lp "$private_root"');
    expect(installer).toContain('ls -lde "$private_root"');
    expect(installer).toContain("grep -Eq '^[[:space:]]*[0-9]+:'");
    expect(installer).toContain('must not have an extended ACL');
    expect(installer).toContain('Add :privateDirectory string $private_directory');
    expect(installer).toContain('--kaizen-home <absolute-kaizen-home>');
    expect(installer).toContain('Scheduled project(s) are not registered');
    expect(installer).toContain('sudo -u "$runtime_user" -- "$node_executable"');
    expect(installer).toContain("/bin/sh -c 'command -v verifier'");
    expect(installer).toContain('"$resolved_verifier" --version --json');
    expect(installer).toContain('Scheduled tool PATH: $tool_path');
    expect(installer).toContain('Verifier shebang:');
    expect(installer).toContain('value.name !== "verifier"');
    expect(installer).toContain('["current", "stale", "unverifiable"].includes(value.status)');
    expect(installer).toContain('value.stale !== expectedStale');
    expect(installer).toContain('!nullableString(value.build.commit)');
    expect(installer).toContain('!nullableBoolean(value.runtime.dirty)');
    expect(installer).toContain('typeof value.runtime.packageRoot !== "string"');
    expect(installer).toContain('plutil -insert kaizenHome');
    expect(installer).toContain('install -o root -g wheel -m 0600 /dev/null');
    expect(installer).toContain('StandardOutPath');
    expect(installer).toContain('StandardErrorPath');
    expect(brokerSource).toContain('chown(config.privateDirectory, 0, config.runtimeGid)');
    expect(brokerSource).toContain('chmod(config.privateDirectory, 0o710)');
    expect(brokerSource).toContain('processPath(pid) == config.scheduledLauncherExecutable');
    expect(brokerSource).toContain('parentPid(pid) == 1 && processPath(1) == "/sbin/launchd"');
    expect(brokerSource).toContain('operation == "scheduled-run" || operation == "scheduled-canary"');
    expect(brokerSource).toContain('authenticateOperatorCanary');
    expect(brokerSource).toContain('mode: 0o620');
    expect(brokerSource).toContain('config.scheduledJobs.first');
    expect(brokerSource).toContain('POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT');
    expect(brokerSource).toContain('kill(-process.processIdentifier, signal)');
    expect(installer).toContain('Add :schedulerSocketPath string /opt/kaizen/run/scheduler.sock');
    expect(installer).toContain('Add :publicationSocketPath string /opt/kaizen/run/publication.sock');
    expect(brokerSource).toContain('let expectedUid: uid_t = testingConfigPath() == nil ? 0 : config.runtimeUid');
    expect(installer).toContain('org.kaizen-agents.scheduled-publication');
    expect(installer).toContain('cp -p "$build_dir/config.backup" "$config_path"');
    expect(installer).toContain('launchctl bootstrap system "$daemon_path"');
    expect(brokerSource).toContain('"GH_TOKEN": token');
    expect(brokerSource).toContain('.rsaSignatureMessagePKCS1v15SHA256');
    expect(brokerSource).toContain('/app/installations/\\(installationId)/access_tokens');
    expect(brokerSource).toContain('cached.expiresAt.timeIntervalSinceNow > 300');
    expect(brokerSource).toContain('catch { return .failure("github-cli-token-unavailable") }\n    guard connected(descriptor)');
    expect(brokerSource).toContain('token(for: config, forceRefresh: true)\n    guard connected(descriptor)');
    expect(brokerSource).toContain('willPerformHTTPRedirection');
    expect(brokerSource).toContain('data.count <= 65_536 - incoming.count');
    expect(brokerSource).toContain('workingDirectory: "/var/empty"');
    expect(supervisorSource).not.toContain('GH_TOKEN');
    expect(supervisorSource).not.toContain('KAIZEN_GITHUB_TOKEN_FD');
    expect(supervisorSource).toContain('GH_CONFIG_DIR=/var/empty');
    expect(supervisorSource).toContain('KAIZEN_HOME=\\(config.kaizenHome)');
    expect(supervisorSource).toContain('arguments.count == 7 && arguments[1] == "run"');
    expect(scheduledSource).toContain('usage: kaizen-scheduled-launcher dispatch | canary <project> <job>');
    expect(scheduledSource).not.toContain('<node> <project> <job>');
    expect(scheduledSource).toContain('geteuid() == 0 || isTest');
    expect(scheduledSource).toContain('canary target is not a registered scheduled job');
  });
});
