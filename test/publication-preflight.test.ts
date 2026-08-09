import { describe, expect, it, vi } from 'vitest';
import { preflightScheduledPublication } from '../src/orchestrator/run.js';
import type { CommandRunner } from '../src/utils/command.js';
import { trustedRunner } from './helpers/trustedRunner.js';

function remoteRunner(url: string): CommandRunner {
  return vi.fn(async (command, args) => ({
    command,
    args,
    cwd: '/repo',
    exitCode: 0,
    stdout: args.join(' ') === 'remote get-url --push --all origin' ? `${url}\n` : '',
    stderr: '',
    durationMs: 1
  }));
}

describe('scheduled publication preflight', () => {
  it('fails before GitHub issue intake when HTTPS has neither a token nor an authenticated broker', async () => {
    const command = remoteRunner('https://github.com/o/r.git');

    await expect(preflightScheduledPublication({
      scheduled: true,
      localPath: '/repo',
      expectedRepo: 'o/r',
      runCommand: trustedRunner(command, {
        githubToken: false,
        githubPublisher: false,
        githubPublicationPreflight: false
      })
    })).rejects.toThrow('before issue intake');

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalledWith('gh', expect.anything(), expect.anything());
  });

  it('requires the broker to authenticate the current registered supervisor', async () => {
    const command = remoteRunner('https://github.com/o/r.git');
    const preflight = vi.fn(async () => undefined);

    await preflightScheduledPublication({
      scheduled: true,
      localPath: '/repo',
      expectedRepo: 'o/r',
      runCommand: trustedRunner(command, {
        githubToken: false,
        githubPublisher: vi.fn(async () => undefined),
        githubPublicationPreflight: preflight
      })
    });

    expect(preflight).toHaveBeenCalledWith({
      pushUrl: 'https://github.com/o/r.git',
      expectedRepo: 'o/r'
    });
  });

  it('does not require the HTTPS broker for manual or SSH publication', async () => {
    const manual = remoteRunner('https://github.com/o/r.git');
    await preflightScheduledPublication({
      scheduled: false,
      localPath: '/repo',
      expectedRepo: 'o/r',
      runCommand: trustedRunner(manual, { githubToken: false, githubPublicationPreflight: false })
    });
    expect(manual).not.toHaveBeenCalled();

    const ssh = remoteRunner('git@github.com:o/r.git');
    await preflightScheduledPublication({
      scheduled: true,
      localPath: '/repo',
      expectedRepo: 'o/r',
      runCommand: trustedRunner(ssh, { githubToken: false, githubPublicationPreflight: false })
    });
    expect(ssh).toHaveBeenCalledOnce();
  });

  it('uses the publication URL instead of the fetch URL', async () => {
    const command = remoteRunner('https://github.com/o/r.git');
    const preflight = vi.fn(async () => undefined);

    await preflightScheduledPublication({
      scheduled: true,
      localPath: '/repo',
      expectedRepo: 'o/r',
      runCommand: trustedRunner(command, {
        githubToken: false,
        githubPublicationPreflight: preflight
      })
    });

    expect(command).toHaveBeenCalledWith('git', ['remote', 'get-url', '--push', '--all', 'origin'], expect.anything());
  });
});
