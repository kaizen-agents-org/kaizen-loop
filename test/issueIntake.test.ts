import { describe, expect, it } from 'vitest';
import {
  buildIssueIntakeComment,
  evaluateIssueIntake,
  hasIssueIntakeDecisionComment
} from '../src/orchestrator/issueIntake.js';
import type { GitHubIssue } from '../src/github/types.js';

describe('evaluateIssueIntake', () => {
  it('proceeds for a scoped improvement', () => {
    expect(evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [],
      issue: issue({
        body: '## Problem\nThe status command omits useful queue counts.\n\n## Expected behavior\nShow the counts in status output.'
      })
    }).status).toBe('proceed');
  });

  it('routes source-of-truth sync work upstream first', () => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: 'The downstream copy drifted from source-of-truth kaizen-agents-org/.github. Syncing it directly would copy the wrong behavior.'
      })
    });

    expect(decision.status).toBe('upstream_first');
    expect(decision.reason).toContain('kaizen-agents-org/.github');
  });

  it('routes GitHub URL source-of-truth references upstream first', () => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: 'The downstream copy drifted from upstream https://github.com/kaizen-agents-org/.github. Sync it from the canonical source.'
      })
    });

    expect(decision.status).toBe('upstream_first');
    expect(decision.reason).toContain('kaizen-agents-org/.github');
  });

  it.each([
    {
      issue: 156,
      body: [
        '## Ownership clarification',
        'The implementation owner is **`kaizen-agents-org/.github`**. The canonical managed source and its sync contract live in this repository.',
        '`kaizen-agents-org/kaizen-loop` is the downstream target where the destructive sync diff becomes visible.',
        'Make the source-managed kaizen-loop dogfood configuration preserve the repository override.'
      ].join('\n\n')
    },
    {
      issue: 157,
      body: [
        '## Ownership clarification',
        'The implementation owner is **`kaizen-agents-org/.github`** because this repository owns the canonical shared skills and the sync contract.',
        '`kaizen-agents-org/builder-agent` and `kaizen-agents-org/verifier` are downstream targets whose restore commits are evidence of drift.',
        '## Ownership key',
        '```text',
        'kaizen-agents-org/.github',
        'builder-agent:skills/kaizen-bug-router',
        'verifier:skills/pr-guardian',
        '```'
      ].join('\n\n')
    },
    {
      issue: 169,
      body: [
        'This is a closed-loop sync-health finding in `.github`, not a verifier implementation bug: `.github` owns the managed dogfood source and deterministic sync contract.',
        '## Ownership key',
        '```text',
        'kaizen-agents-org/.github',
        'verifier:.kaizen/config.yml',
        '```',
        'The target repository is `kaizen-agents-org/verifier`, where canonical config drift is visible.'
      ].join('\n\n')
    }
  ])('reruns .github issue #$issue without restoring upstream-first', ({ body }) => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({ body })
    });

    expect(decision.status).toBe('proceed');
    expect(decision.status).not.toBe('upstream_first');
  });

  it('fails closed when explicit ownership statements conflict', () => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({
        body: [
          '## Ownership clarification',
          'The implementation owner is `kaizen-agents-org/.github`.',
          '## Ownership key',
          'kaizen-agents-org/verifier',
          'Sync the downstream copy after resolving the drift.'
        ].join('\n')
      })
    });

    expect(decision.status).toBe('needs_context');
    expect(decision.reason).toContain('conflicting explicit ownership');
  });

  it('still routes an explicitly named external canonical owner upstream first', () => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: [
          '## Ownership clarification',
          'The canonical owner is `kaizen-agents-org/.github`.',
          'The downstream skill copy has drifted and must be synced from that source.'
        ].join('\n')
      })
    });

    expect(decision.status).toBe('upstream_first');
    expect(decision.reason).toContain('kaizen-agents-org/.github');
  });

  it('accepts allowed structured owner values case-insensitively', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: [
          '## Ownership clarification',
          'The canonical owner is `KAIZEN-AGENTS-ORG/.GITHUB`.',
          'The downstream copy drifted from the canonical source and needs sync.'
        ].join('\n')
      })
    }).status).toBe('upstream_first');
  });

  it.each(['attacker/example', 'kaizen-agents-org/archived-repo'])(
    'rejects structured owner %s outside the Organization allowlist',
    (owner) => {
      const decision = evaluateIssueIntake({
        repo: 'kaizen-agents-org/kaizen-loop',
        openPullRequests: [],
        issue: issue({
          body: [
            '## Ownership clarification',
            `The canonical owner is \`${owner}\`.`,
            'The downstream copy drifted and needs sync.'
          ].join('\n')
        })
      });

      expect(decision.status).toBe('needs_context');
      expect(decision.reason).toContain('outside the repositories allowed');
    }
  );

  it('rejects URL owner fields as malformed', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: [
          '## Ownership clarification',
          'The canonical owner is https://github.com/kaizen-agents-org/.github.',
          'The downstream copy drifted and needs sync.'
        ].join('\n')
      })
    }).status).toBe('needs_context');
  });

  it.each([
    '> The canonical owner is `kaizen-agents-org/.github`.',
    '```text\nThe canonical owner is `kaizen-agents-org/.github`.\n```'
  ])('rejects quoted or template owner declarations: %s', (declaration) => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: `## Ownership clarification\n${declaration}\nThe downstream copy drifted and needs sync.`
      })
    }).status).toBe('needs_context');
  });

  it('rejects owner declarations outside a structured ownership section', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: 'The canonical owner is `kaizen-agents-org/.github`. The downstream copy drifted and needs sync.'
      })
    }).status).toBe('needs_context');
  });

  it('rejects malformed and multiple owner fields', () => {
    for (const body of [
      '## Ownership clarification\nThe implementation owner is TBD.\nThe downstream copy drifted.',
      [
        '## Ownership clarification',
        'The implementation owner is `kaizen-agents-org/.github`.',
        'The canonical owner is `kaizen-agents-org/.github`.',
        'The downstream copy drifted.'
      ].join('\n')
    ]) {
      expect(evaluateIssueIntake({
        repo: 'kaizen-agents-org/kaizen-loop',
        openPullRequests: [],
        issue: issue({ body })
      }).status).toBe('needs_context');
    }
  });

  it('does not let non-Kaizen organizations redirect intake to another repository', () => {
    expect(evaluateIssueIntake({
      repo: 'acme/app',
      openPullRequests: [],
      issue: issue({
        body: 'The downstream copy drifted from canonical acme/shared and needs sync.'
      })
    }).status).toBe('needs_context');
  });

  it('fails closed when source-of-truth text names multiple possible upstream repositories', () => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: 'The canonical sync between kaizen-agents-org/.github and kaizen-agents-org/verifier has drifted, with no owner specified.'
      })
    });

    expect(decision.status).toBe('needs_context');
    expect(decision.reason).toContain('multiple possible upstream repositories');
  });

  it('routes live cross-repository workflows to a human', () => {
    const decision = evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({
        title: 'Complete first non-Node dogfood run: Issue→PR→merge on a non-Node repository',
        body: [
          'Select a separate Rust repository.',
          'Run kaizen init there.',
          'Complete the live Issue→PR→merge workflow.'
        ].join('\n')
      })
    });

    expect(decision.status).toBe('needs_human');
    expect(decision.reason).toContain('outside kaizen-agents-org/.github');
  });

  it('routes imperative body-only cross-repository workflows to a human', () => {
    expect(evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [],
      issue: issue({
        title: 'Dogfood the full workflow',
        body: [
          '- Select another Python repository.',
          '- Run kaizen init there.',
          '- Open and merge the resulting pull request.'
        ].join('\n')
      })
    }).status).toBe('needs_human');
  });

  it('routes workflows naming a specific external repository to a human', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({
        title: 'Run kaizen init in kaizen-agents-org/python-dogfood',
        body: 'Open and merge the resulting pull request in that repository.'
      })
    }).status).toBe('needs_human');
  });

  it('uses non-imperative target metadata when classifying live directives', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({
        title: 'Complete the non-Node dogfood run',
        body: [
          'Target repository: kaizen-agents-org/python-dogfood',
          'Run kaizen init there.',
          'Open and merge the resulting pull request.'
        ].join('\n')
      })
    }).status).toBe('needs_human');
  });

  it('does not route command-shaped failure reports as live external work', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        title: 'Run kaizen init in another repository fails',
        body: [
          'Steps to reproduce:',
          '- Select a separate Rust repository.',
          '- Run kaizen init there.',
          'Expected: Kaizen Loop should report the failure and continue safely.'
        ].join('\n')
      })
    }).status).toBe('proceed');
  });

  it('does not route reports about cross-repository dispatch as live external work', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        title: 'Kaizen Loop dispatches Issue→PR→merge work on another repo to a single-repo builder',
        body: [
          'Issue #120 asks the builder to perform these steps:',
          '- Select an external repository.',
          '- Run kaizen init there.',
          'Expected: Kaizen Loop should detect this unsupported scope and route it to a human.'
        ].join('\n')
      })
    }).status).toBe('proceed');
  });

  it('does not treat file paths as upstream repositories', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/kaizen-loop',
      openPullRequests: [],
      issue: issue({
        body: 'The docs/04-nightly-pipeline.md section drifted from the source-of-truth wording and needs sync.'
      })
    }).status).toBe('proceed');
  });

  it('does not treat slash-separated prose as upstream repositories', () => {
    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({
        body: 'Make .github/docs canonical and fix evaluation/playbook drift in the repo copy.'
      })
    }).status).toBe('proceed');

    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({
        body: 'Add checks for source prompt paths/components so automation docs do not drift from the canonical source.'
      })
    }).status).toBe('proceed');

    expect(evaluateIssueIntake({
      repo: 'kaizen-agents-org/.github',
      openPullRequests: [],
      issue: issue({
        body: 'Update the playbook checklist/progress log to reflect A-3/A-4 completion.'
      })
    }).status).toBe('proceed');
  });

  it('rejects recommended actions that weaken review guardrails', () => {
    const decision = evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [],
      issue: issue({
        body: 'Suggested design: should remove PR Guardian review feedback checks so pull requests finish faster.'
      })
    });

    expect(decision.status).toBe('not_improvement');
  });

  it('detects already resolved work from current PR markers', () => {
    const decision = evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [{ number: 4, headRefName: 'kaizen/issue-12-fix', url: 'https://github.com/o/r/pull/4' }],
      issue: issue({
        number: 12,
        comments: [
          {
            body: '<!-- kaizen-loop:result {"attempt":1,"outcome":"pr-created","pr":"https://github.com/o/r/pull/4"} -->'
          }
        ]
      })
    });

    expect(decision.status).toBe('already_resolved');
  });

  it('asks for context on vague title-only issues', () => {
    expect(evaluateIssueIntake({
      repo: 'o/r',
      openPullRequests: [],
      issue: issue({ title: 'Fix bug', body: '' })
    }).status).toBe('needs_context');
  });

  it('stamps intake comments with a detectable decision marker', () => {
    const body = buildIssueIntakeComment('20260612T000000Z', {
      status: 'already_resolved',
      reason: 'Existing work appears to already address this issue.',
      evidence: []
    });

    expect(hasIssueIntakeDecisionComment(issue({ comments: [{ body }] }), 'already_resolved')).toBe(true);
  });
});

function issue(options: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: options.number ?? 1,
    title: options.title ?? 'Improve behavior',
    body: options.body ?? 'Enough detail to proceed.',
    labels: options.labels ?? [{ name: 'kaizen' }],
    createdAt: options.createdAt ?? '2026-06-12T00:00:00Z',
    comments: options.comments ?? []
  };
}
