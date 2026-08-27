import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = path.resolve(import.meta.dirname, '../scripts/macos/wait-for-unix-socket.mjs');

function runHelper(socketPath: string, timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [helper, socketPath, String(timeoutMs)], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

describe.runIf(process.platform !== 'win32')('wait-for-unix-socket', () => {
  it('retries until a socket accepts and answers a request', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-socket-ready-'));
    const socketPath = path.join(root, 'scheduler.sock');
    const pending = runHelper(socketPath, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end('{"ok":false}\n'));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(pending).resolves.toEqual({ code: 0, stderr: '' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails after the bounded timeout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-socket-timeout-'));
    const socketPath = path.join(root, 'missing.sock');
    try {
      const result = await runHelper(socketPath, 200);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`timed out waiting for ${socketPath}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('requires a broker-shaped JSON response', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-socket-protocol-'));
    const socketPath = path.join(root, 'scheduler.sock');
    let connections = 0;
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        connections += 1;
        socket.end(connections === 1 ? 'not-json\n' : '{"ok":false,"error":"invalid request"}\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(runHelper(socketPath, 2_000)).resolves.toEqual({ code: 0, stderr: '' });
      expect(connections).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe arguments', () => {
    const result = spawnSync(process.execPath, [helper, 'relative.sock', '1000'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: wait-for-unix-socket.mjs');
  });
});
