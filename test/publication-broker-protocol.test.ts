import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestBrokerGitHubCli, requestGithubPublication } from '../src/utils/command.js';

// The broker lives in kaizen-agents-org/.github and speaks to kaizen-loop only
// over a Unix socket, so neither repository's tests exercise the wire contract
// between them. These cases pin the client half against the exact responses the
// broker emits, so a refusal it names cannot silently become "publication
// failed" with no reason -- which is what made a real failure undiagnosable.

const sockets: net.Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of sockets.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

// Publication requests are processed after the client half-closes. GitHub CLI
// requests are processed as soon as their newline-delimited frame is complete,
// because that connection must remain open while the command is running.
async function startFakeBroker(response: unknown | ((request: unknown) => unknown)): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-broker-protocol-'));
  directories.push(directory);
  const socketPath = path.join(directory, 'broker.sock');
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    let responded = false;
    const respond = () => {
      if (responded) return;
      responded = true;
      let parsed: unknown;
      try { parsed = JSON.parse(input.trim()); } catch { parsed = undefined; }
      const body = typeof response === 'function'
        ? (response as (request: unknown) => unknown)(parsed)
        : response;
      socket.end(typeof body === 'string' ? body : `${JSON.stringify(body)}\n`);
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.endsWith('\n')) {
        try {
          const parsed = JSON.parse(input.trim()) as { operation?: unknown };
          if (parsed.operation === 'github-cli') respond();
        } catch { /* wait for EOF so malformed publication requests keep their existing behavior */ }
      }
    });
    socket.on('end', () => {
      respond();
    });
  });
  sockets.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

// The trust checks in resolveConfiguredBrokerSocket require a root-owned socket
// in root-owned directories, which a test cannot create; call the request layer
// directly so these cases cover the wire contract rather than those checks.
function publisherFor(socketPath: string) {
  return (request: Parameters<typeof requestGithubPublication>[2]) =>
    requestGithubPublication(socketPath, undefined, request, 5_000);
}

const request = {
  cwd: '/tmp/publication',
  pushUrl: 'https://github.com/owner/repo.git',
  refspec: 'kaizen/issue-1:refs/heads/kaizen/issue-1',
  expectedRepo: 'owner/repo',
  expectedSha: 'a'.repeat(40)
};

describe('publication broker wire contract', () => {
  it('resolves when the broker acknowledges the push', async () => {
    const publisher = publisherFor(await startFakeBroker({ ok: true }));
    await expect(publisher(request)).resolves.toBeUndefined();
  });

  // Each refusal code has a different operator fix -- an allow-list entry, a
  // directory mode, a branch choice -- so the code must reach the caller.
  it.each([
    'repository-not-allowed',
    'default-branch-refused',
    'invalid-cwd',
    'invalid-refspec',
    'expected-sha-mismatch',
    'git-failed'
  ])('surfaces the refusal code %s', async (code) => {
    const publisher = publisherFor(await startFakeBroker({ ok: false, error: code }));
    await expect(publisher(request)).rejects.toThrow(code);
  });

  it('reports a refusal that carries no code', async () => {
    const publisher = publisherFor(await startFakeBroker({ ok: false }));
    await expect(publisher(request)).rejects.toThrow(/unspecified reason/);
  });

  // The response arrives from outside this process and ends up in issue
  // comments, so it must not be able to inject prose or quote a credential.
  it.each([
    'not a code: https://x-access-token:ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/o/r.git',
    'UPPER-CASE',
    'has spaces',
    'a'.repeat(200)
  ])('refuses to echo an error field that is not a refusal code (%#)', async (payload) => {
    const publisher = publisherFor(await startFakeBroker({ ok: false, error: payload }));
    const error = await publisher(request).catch((caught: unknown) => caught);
    expect(String(error)).toContain('unspecified reason');
    expect(String(error)).not.toContain('ghp_');
    expect(String(error)).not.toContain(payload);
  });

  it('distinguishes an absent socket from a refusal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-broker-missing-'));
    directories.push(directory);
    const publisher = publisherFor(path.join(directory, 'absent.sock'));
    await expect(publisher(request)).rejects.toThrow(/probably not running/);
  });

  it('rejects a malformed multi-line response', async () => {
    const publisher = publisherFor(await startFakeBroker('{"ok":true}\n{"ok":true}\n'));
    await expect(publisher(request)).rejects.toThrow(/malformed multi-line/);
  });

  it('rejects a response that is not JSON', async () => {
    const publisher = publisherFor(await startFakeBroker('ok\n'));
    await expect(publisher(request)).rejects.toThrow(/not JSON/);
  });

  // `JSON.parse` accepts these, and reading `.ok` off `null` throws inside the
  // 'end' handler where nothing catches it -- the request would hang until the
  // absolute timeout instead of failing immediately.
  it.each(['null\n', '[]\n', '"text"\n', '42\n'])(
    'rejects a JSON response that is not an object (%j)',
    async (payload) => {
      const publisher = publisherFor(await startFakeBroker(payload));
      await expect(publisher(request)).rejects.toThrow(/not a JSON object/);
    }
  );

  // Regression: the client used to write the request without half-closing, so
  // the broker -- which parses only on end-of-input -- waited for its own read
  // timeout and answered `request-timeout`. Every HTTPS publication failed that
  // way, ten seconds at a time, reported as a failed publication.
  it('half-closes the request so a broker that parses on end-of-input can reply', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-broker-halfclose-'));
    directories.push(directory);
    const socketPath = path.join(directory, 'broker.sock');
    let sawEnd = false;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('data', () => undefined);
      socket.on('end', () => {
        sawEnd = true;
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      });
    });
    sockets.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(publisherFor(socketPath)(request)).resolves.toBeUndefined();
    expect(sawEnd).toBe(true);
  });

  it('sends the versioned request shape the broker validates', async () => {
    let received: Record<string, unknown> | undefined;
    const publisher = publisherFor(await startFakeBroker((parsed) => {
      received = parsed as Record<string, unknown>;
      return { ok: true };
    }));
    await publisher({ ...request, forceWithLease: '--force-with-lease=refs/heads/kaizen/issue-1:' });
    // assertExactKeys in the broker rejects unknown or missing keys outright,
    // so this must be an exact match: toMatchObject would pass while the broker
    // refused the very request it accepted here.
    expect(received).toEqual({
      version: 1,
      operation: 'git-push',
      cwd: request.cwd,
      pushUrl: request.pushUrl,
      refspec: request.refspec,
      expectedRepo: request.expectedRepo,
      expectedSha: request.expectedSha,
      forceWithLease: '--force-with-lease=refs/heads/kaizen/issue-1:'
    });
  });
});

describe('GitHub CLI broker wire contract', () => {
  it('keeps the request write half open until the broker responds', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-github-cli-broker-'));
    directories.push(directory);
    const socketPath = path.join(directory, 'broker.sock');
    let clientHalfClosedBeforeResponse = false;
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('end', () => { clientHalfClosedBeforeResponse = true; });
      socket.on('data', (chunk) => {
        input += chunk;
        if (input.endsWith('\n')) {
          setTimeout(() => socket.end(`${JSON.stringify({ ok: true, exitCode: 0, stdoutBase64: '', stderrBase64: '' })}\n`), 25);
        }
      });
    });
    sockets.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(requestBrokerGitHubCli(
      socketPath, 'a'.repeat(64), '/trusted/bin/gh', ['api', 'user'], { cwd: '/workspace' }, 10_000
    )).resolves.toMatchObject({ exitCode: 0 });
    expect(clientHalfClosedBeforeResponse).toBe(false);
  });

  it('returns a bounded command result and sends no credential', async () => {
    let received: Record<string, unknown> | undefined;
    const socketPath = await startFakeBroker((parsed) => {
      received = parsed as Record<string, unknown>;
      return { ok: true, exitCode: 0, stdoutBase64: Buffer.from('[]\n').toString('base64'), stderrBase64: '' };
    });
    await expect(requestBrokerGitHubCli(
      socketPath,
      'a'.repeat(64),
      '/trusted/bin/gh',
      ['issue', 'list'],
      { cwd: '/workspace' },
      10_000
    )).resolves.toMatchObject({ exitCode: 0, stdout: '[]\n' });
    expect(received).toEqual({
      version: 1,
      operation: 'github-cli',
      capability: 'a'.repeat(64),
      args: ['issue', 'list'],
      cwd: '/workspace',
      input: '',
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024 * 1024
    });
    expect(JSON.stringify(received)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|credential/i);
  });

  it('preserves nonzero GitHub CLI results when requested', async () => {
    const socketPath = await startFakeBroker({
      ok: true,
      exitCode: 4,
      stdoutBase64: '',
      stderrBase64: Buffer.from('not found\n').toString('base64')
    });
    await expect(requestBrokerGitHubCli(
      socketPath,
      'b'.repeat(64),
      '/trusted/bin/gh',
      ['issue', 'view', '404'],
      { cwd: '/workspace', rejectOnNonZero: false },
      10_000
    )).resolves.toMatchObject({ exitCode: 4, stderr: 'not found\n' });
  });

  it('rejects malformed or oversized command results', async () => {
    const malformed = await startFakeBroker({ ok: true, exitCode: 0, stdoutBase64: 42, stderrBase64: '' });
    await expect(requestBrokerGitHubCli(
      malformed, undefined, '/trusted/bin/gh', ['auth', 'status'], { cwd: '/workspace' }, 10_000
    )).rejects.toThrow(/malformed command result/);

    const oversized = await startFakeBroker({
      ok: true,
      exitCode: 0,
      stdoutBase64: Buffer.from('xx').toString('base64'),
      stderrBase64: ''
    });
    await expect(requestBrokerGitHubCli(
      oversized, undefined, '/trusted/bin/gh', ['auth', 'status'], { cwd: '/workspace', maxOutputBytes: 1 }, 10_000
    )).rejects.toThrow(/output limit|malformed command result/);
  });

  it('rejects a client-valid request whose serialized frame exceeds the broker limit', async () => {
    await expect(requestBrokerGitHubCli(
      '/tmp/unused-broker.sock',
      'c'.repeat(64),
      '/trusted/bin/gh',
      ['x'.repeat(262_144), 'y'.repeat(262_144)],
      { cwd: '/workspace', input: 'z'.repeat(524_288) },
      10_000
    )).rejects.toThrow(/wire limit/);
  });
});
