import type { GitHubIssue, GitHubPullRequest } from '../github/types.js';
import { hasPendingPullRequest } from '../report/comments.js';

export type IssueIntakeDecisionStatus =
  | 'proceed'
  | 'needs_human'
  | 'needs_context'
  | 'upstream_first'
  | 'not_improvement'
  | 'already_resolved';

export interface IssueIntakeDecision {
  status: IssueIntakeDecisionStatus;
  reason: string;
  evidence: string[];
}

export function hasIssueIntakeDecisionComment(issue: GitHubIssue, status: IssueIntakeDecisionStatus): boolean {
  return (issue.comments ?? []).some((comment) =>
    comment.body.includes(`<!-- kaizen-loop:intake-decision status=${status} -->`)
  );
}

export function evaluateIssueIntake(options: {
  issue: GitHubIssue;
  repo: string;
  openPullRequests: GitHubPullRequest[];
}): IssueIntakeDecision {
  const text = issueText(options.issue);
  const normalized = text.toLowerCase();

  if (hasPendingPullRequest(options.issue.comments ?? [], options.openPullRequests) || alreadyResolvedText(normalized)) {
    return {
      status: 'already_resolved',
      reason: 'Existing work appears to already address this issue.',
      evidence: ['Issue comments or related PR state indicate an existing resolution path.']
    };
  }

  const upstreamRepo = referencedUpstreamRepo(text, options.repo);
  if (upstreamRepo && mentionsSourceOfTruthSync(normalized)) {
    return {
      status: 'upstream_first',
      reason: `The issue describes source-of-truth drift; fix ${upstreamRepo} before downstream sync work.`,
      evidence: [`Referenced upstream/source-of-truth repository: ${upstreamRepo}`]
    };
  }

  if (requiresLiveCrossRepositoryAction(options.issue, options.repo)) {
    return {
      status: 'needs_human',
      reason: `The requested workflow requires live actions in a repository outside ${options.repo}.`,
      evidence: [
        'The builder workspace and execution authorization are scoped to the repository being processed.'
      ]
    };
  }

  if (weakensGuardrails(normalized)) {
    return {
      status: 'not_improvement',
      reason: 'The recommended action appears to weaken safety, verification, or review guardrails.',
      evidence: ['Issue text combines removal/relaxation language with safety, verification, or review controls.']
    };
  }

  if (lacksActionableContext(options.issue)) {
    return {
      status: 'needs_context',
      reason: 'The issue does not include enough evidence or expected behavior for safe automated implementation.',
      evidence: ['Issue body is missing or too short to identify a concrete improvement.']
    };
  }

  return {
    status: 'proceed',
    reason: 'The issue appears to describe a scoped improvement suitable for builder execution.',
    evidence: []
  };
}

export function buildIssueIntakeComment(runId: string, decision: IssueIntakeDecision): string {
  const evidence = decision.evidence.length
    ? decision.evidence.map((item) => `- ${item}`).join('\n')
    : '- No additional evidence recorded.';

  return `<!-- kaizen-loop:intake-decision status=${decision.status} -->

## Kaizen Loop intake decision

The issue was treated as evidence rather than as an implementation order.

| | |
|---|---|
| Run | ${runId} |
| Decision | \`${decision.status}\` |
| Reason | ${decision.reason} |

## Evidence
${evidence}`;
}

function issueText(issue: GitHubIssue): string {
  const comments = (issue.comments ?? []).map((comment) => comment.body).join('\n\n');
  return [issue.title, issue.body, comments].filter(Boolean).join('\n\n');
}

function alreadyResolvedText(normalized: string): boolean {
  return /\balready\s+(resolved|fixed|addressed)\b/.test(normalized) || /\b(resolved|fixed|addressed)\s+by\s+#\d+\b/.test(normalized);
}

function referencedUpstreamRepo(text: string, currentRepo: string): string | undefined {
  const [currentOwner] = currentRepo.split('/');
  const urlRepos = [...text.matchAll(/(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[/?#\s).,;:'"`\]])/g)]
    .map((match) => match[1]);
  const bareRepos = [...text.matchAll(/(?:^|[\s([`])([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+)(?=$|[\s).,;:'"`\]])/g)]
    .map((match) => match[1])
    .filter((repo) => !isPathLikeRepoReference(repo, currentOwner));
  return [...urlRepos, ...bareRepos].find((repo) => repo !== currentRepo);
}

function isPathLikeRepoReference(repo: string, currentOwner: string | undefined): boolean {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return true;
  if (['docs', 'src', 'test', 'tests', 'scripts', 'dist', 'lib'].includes(owner.toLowerCase())) return true;
  if (isChecklistItemReference(owner) || isChecklistItemReference(name)) return true;
  if (!isLikelyBareRepoOwner(owner, currentOwner) && !name.startsWith('.')) return true;
  return !name.startsWith('.') && /\.[A-Za-z0-9]{1,8}$/.test(name);
}

function isChecklistItemReference(part: string): boolean {
  return /^[A-Za-z]-\d+$/.test(part);
}

function isLikelyBareRepoOwner(owner: string, currentOwner: string | undefined): boolean {
  return owner === currentOwner || owner.includes('-') || owner.includes('.');
}

function mentionsSourceOfTruthSync(normalized: string): boolean {
  return (
    /(source[- ]of[- ]truth|upstream|canonical)/.test(normalized) &&
    /(sync|copy|drift|downstream|mirror|vendored)/.test(normalized)
  );
}

function requiresLiveCrossRepositoryAction(issue: GitHubIssue, currentRepo: string): boolean {
  const directiveText = requestedActionDirectives(issue);
  if (!directiveText) return false;
  const normalized = directiveText.toLowerCase();
  return mentionsExternalRepositoryTarget(directiveText, normalized, currentRepo) && mentionsLiveRepositoryWorkflow(normalized);
}

function requestedActionDirectives(issue: GitHubIssue): string {
  const imperative = /^\s*(?:(?:[-*+]|\d+[.)])\s*)?(?:choose|complete|create|dogfood|execute|init(?:ialize)?|merge|open|perform|push|run|select|test|validate)\b/i;
  if (reportsExistingFailure(issue.title) && !imperative.test(issue.title)) return '';
  const directives = (issue.body ?? '').split('\n').filter((line) => imperative.test(line));
  if (imperative.test(issue.title)) directives.unshift(issue.title);
  return directives.join('\n');
}

function reportsExistingFailure(title: string): boolean {
  return /\b(?:blocked|bug|cannot|dispatch(?:ed|es|ing)?|fail(?:ed|ing|s|ure)?|invalid|wrong)\b/i.test(title);
}

function mentionsExternalRepositoryTarget(text: string, normalized: string, currentRepo: string): boolean {
  if (referencedUpstreamRepo(text, currentRepo)) return true;
  return (
    /\b(?:another|different|external|non[- ]node|other|separate)(?:\s+[a-z0-9.+#-]+){0,3}\s+repositor(?:y|ies)\b/.test(normalized) ||
    /\brepositor(?:y|ies)\s+(?:different\s+from|other\s+than|outside)\b/.test(normalized)
  );
}

function mentionsLiveRepositoryWorkflow(normalized: string): boolean {
  return (
    /\bkaizen\s+init\b/.test(normalized) ||
    /\bissue\s*(?:→|->|to)\s*(?:pull request|pr)\s*(?:→|->|to)\s*merge\b/.test(normalized) ||
    /\bgit\s+push\b/.test(normalized) ||
    /\b(?:create|merge|open|push)\b[^.\n]{0,40}\b(?:pull request|pr|remote)\b/.test(normalized)
  );
}

function weakensGuardrails(normalized: string): boolean {
  return /\b(should|must|please|recommend(?:ed)?|expected|suggested)[^.\n]*(remove|drop|delete|disable|skip|relax|weaken)[^.\n]*(safety|guardrail|verification|review|pr guardian|checks?|tests?|approval|feedback)/.test(normalized);
}

function lacksActionableContext(issue: GitHubIssue): boolean {
  const title = issue.title.trim().toLowerCase();
  const body = issue.body?.trim() ?? '';
  const commentsLength = (issue.comments ?? []).reduce((sum, comment) => sum + comment.body.trim().length, 0);
  const detailsLength = body.length + commentsLength;
  const text = issueText(issue).trim().toLowerCase();
  if (!issue.title.trim() && !text) return true;
  if (detailsLength < 40 && /^(fix|bug|fix bug|improve|improve behavior|broken|issue)$/i.test(title)) return true;
  return /\b(tbd|todo|needs context|more info needed|insufficient details|unknown expected behavior)\b/.test(text);
}
