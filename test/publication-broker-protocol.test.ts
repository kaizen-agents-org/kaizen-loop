import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestGithubPublication } from '../src/utils/command.js';

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

// Mirrors the real broker's framing: read until the client half-closes, then
// answer with a single JSON line and end. A client that never half-closes hangs
// here exactly as it does against the real broker.
async function startFakeBroker(response: unknown | ((request: unknown) => unknown)): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-broker-protocol-'));
  directories.push(directory);
  const socketPath = path.join(directory, 'broker.sock');
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { input += chunk; });
    socket.on('end', () => {
      let parsed: unknown;
      try { parsed = JSON.parse(input.trim()); } catch { parsed = undefined; }
      const body = typeof response === 'function'
        ? (response as (request: unknown) => unknown)(parsed)
        : response;
      socket.end(typeof body === 'string' ? body : `${JSON.stringify(body)}\n`);
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
    // so the client must send exactly this shape.
    expect(received).toMatchObject({
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
