import { hasPendingPullRequest } from '../report/comments.js';
const KAIZEN_AGENT_REPOS = new Set([
    'kaizen-agents-org/.github',
    'kaizen-agents-org/builder-agent',
    'kaizen-agents-org/coderabbit',
    'kaizen-agents-org/kaizen-loop',
    'kaizen-agents-org/renovate-config',
    'kaizen-agents-org/verifier'
]);
export function hasIssueIntakeDecisionComment(issue, status) {
    return (issue.comments ?? []).some((comment) => comment.body.includes(`<!-- kaizen-loop:intake-decision status=${status} -->`));
}
export function evaluateIssueIntake(options) {
    const text = issueText(options.issue);
    const normalized = text.toLowerCase();
    if (hasPendingPullRequest(options.issue.comments ?? [], options.openPullRequests) || alreadyResolvedText(normalized)) {
        return {
            status: 'already_resolved',
            reason: 'Existing work appears to already address this issue.',
            evidence: ['Issue comments or related PR state indicate an existing resolution path.']
        };
    }
    const explicitOwnership = parseExplicitOwnership(options.issue.body ?? '');
    if (explicitOwnership.errors.length > 0) {
        return {
            status: 'needs_context',
            reason: 'The issue contains invalid or ambiguous structured ownership metadata.',
            evidence: explicitOwnership.errors
        };
    }
    const explicitOwners = explicitOwnership.repos;
    if (explicitOwners.length > 1) {
        return {
            status: 'needs_context',
            reason: 'The issue contains conflicting explicit ownership statements.',
            evidence: explicitOwners.map((repo) => `Explicitly named owner: ${repo}`)
        };
    }
    const explicitOwner = explicitOwners[0];
    if (explicitOwner && !isAllowedOwnershipRepo(explicitOwner, options.repo)) {
        return {
            status: 'needs_context',
            reason: 'The explicitly named owner is outside the repositories allowed for this Organization.',
            evidence: [`Rejected owner repository: ${explicitOwner}`]
        };
    }
    const currentRepoIsExplicitOwner = explicitOwner
        ? sameRepo(explicitOwner, options.repo)
        : false;
    const inferredUpstreamRepos = explicitOwner
        ? []
        : referencedUpstreamRepos(text, options.repo);
    const disallowedInferredRepos = inferredUpstreamRepos.filter((repo) => !isAllowedOwnershipRepo(repo, options.repo));
    if (mentionsSourceOfTruthSync(normalized) && disallowedInferredRepos.length > 0) {
        return {
            status: 'needs_context',
            reason: 'The issue names a possible upstream repository outside the repositories allowed for this Organization.',
            evidence: disallowedInferredRepos.map((repo) => `Rejected upstream repository: ${repo}`)
        };
    }
    if (mentionsSourceOfTruthSync(normalized) && inferredUpstreamRepos.length > 1) {
        return {
            status: 'needs_context',
            reason: 'The issue names multiple possible upstream repositories without an explicit owner.',
            evidence: inferredUpstreamRepos.map((repo) => `Possible upstream repository: ${repo}`)
        };
    }
    const upstreamRepo = currentRepoIsExplicitOwner
        ? undefined
        : explicitOwner ?? inferredUpstreamRepos[0];
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
export function buildIssueIntakeComment(runId, decision) {
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
function issueText(issue) {
    const comments = (issue.comments ?? []).map((comment) => comment.body).join('\n\n');
    return [issue.title, issue.body, comments].filter(Boolean).join('\n\n');
}
function alreadyResolvedText(normalized) {
    return /\balready\s+(resolved|fixed|addressed)\b/.test(normalized) || /\b(resolved|fixed|addressed)\s+by\s+#\d+\b/.test(normalized);
}
function parseExplicitOwnership(body) {
    const repos = [];
    const errors = [];
    const ownerDeclaration = /\b(?:implementation|canonical)(?:\s+repository)?\s+owner\s+(?:is|:)/i;
    const ownerFieldPrefix = /^(?:the\s+)?(?:implementation|canonical)(?:\s+repository)?\s+owner\s+(?:is|:)/i;
    const ownerField = /^(?:the\s+)?(?:implementation|canonical)(?:\s+repository)?\s+owner\s+(?:is|:)\s*(?:\*{1,2})?`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?(?:\*{1,2})?(?=$|[.,;\s])/i;
    const clarificationPattern = /^##\s+Ownership clarification\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gim;
    const clarificationSections = [...body.matchAll(clarificationPattern)];
    if (clarificationSections.length > 1) {
        errors.push('Multiple Ownership clarification sections were found.');
    }
    for (const section of clarificationSections) {
        let inFence = false;
        let fields = 0;
        for (const rawLine of section[1].split('\n')) {
            const line = rawLine.trim();
            if (line.startsWith('```')) {
                inFence = !inFence;
                continue;
            }
            const unquoted = line.replace(/^>\s*/, '');
            if (!ownerFieldPrefix.test(unquoted)) {
                if (ownerDeclaration.test(unquoted)) {
                    errors.push('Owner fields must start at the beginning of a line in Ownership clarification.');
                }
                continue;
            }
            if (inFence || line.startsWith('>')) {
                errors.push('Ownership declarations in quotes or fenced templates are not authoritative.');
                continue;
            }
            fields += 1;
            const repo = unquoted.match(ownerField)?.[1];
            if (!repo) {
                errors.push('Malformed owner field in Ownership clarification.');
            }
            else {
                repos.push(repo);
            }
        }
        if (fields > 1)
            errors.push('Ownership clarification contains multiple owner fields.');
    }
    const ownershipKeyPattern = /^##\s+Ownership key\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gim;
    const ownershipKeySections = [...body.matchAll(ownershipKeyPattern)];
    if (ownershipKeySections.length > 1)
        errors.push('Multiple Ownership key sections were found.');
    for (const section of ownershipKeySections) {
        const lines = section[1].split('\n').map((line) => line.trim()).filter(Boolean);
        if (lines[0]?.startsWith('```'))
            lines.shift();
        const firstValue = lines[0] ?? '';
        const repo = firstValue.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/)?.[1];
        if (!repo) {
            errors.push('Ownership key must start with a repository in owner/name form.');
        }
        else {
            repos.push(repo);
        }
    }
    const structuredRanges = [...clarificationSections, ...ownershipKeySections]
        .map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
    let unstructuredText = body;
    for (const [start, end] of structuredRanges.sort((left, right) => right[0] - left[0])) {
        unstructuredText = `${unstructuredText.slice(0, start)}${' '.repeat(end - start)}${unstructuredText.slice(end)}`;
    }
    if (ownerDeclaration.test(unstructuredText)) {
        errors.push('Ownership declarations must be inside an Ownership clarification or Ownership key section.');
    }
    return {
        repos: repos.filter((repo, index) => repos.findIndex((candidate) => sameRepo(candidate, repo)) === index),
        errors
    };
}
function sameRepo(left, right) {
    return left.toLowerCase() === right.toLowerCase();
}
function isAllowedOwnershipRepo(repo, currentRepo) {
    const [currentOwner] = currentRepo.toLowerCase().split('/');
    if (currentOwner === 'kaizen-agents-org')
        return KAIZEN_AGENT_REPOS.has(repo.toLowerCase());
    return sameRepo(repo, currentRepo);
}
function referencedUpstreamRepos(text, currentRepo) {
    const [currentOwner] = currentRepo.split('/');
    const urlRepos = [...text.matchAll(/(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[/?#\s).,;:'"`\]])/g)]
        .map((match) => normalizeRepoReference(match[1]));
    const bareRepos = [...text.matchAll(/(?:^|[\s([`])([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+)(?=$|[\s).,;:'"`\]])/g)]
        .map((match) => normalizeRepoReference(match[1]))
        .filter((repo) => !isPathLikeRepoReference(repo, currentOwner));
    const repos = [...urlRepos, ...bareRepos].filter((repo) => !sameRepo(repo, currentRepo));
    return repos.filter((repo, index) => repos.findIndex((candidate) => sameRepo(candidate, repo)) === index);
}
function normalizeRepoReference(repo) {
    return repo.replace(/[.,;:]+$/, '');
}
function isPathLikeRepoReference(repo, currentOwner) {
    const [owner, name] = repo.split('/');
    if (!owner || !name)
        return true;
    if (['docs', 'src', 'test', 'tests', 'scripts', 'dist', 'lib'].includes(owner.toLowerCase()))
        return true;
    if (isChecklistItemReference(owner) || isChecklistItemReference(name))
        return true;
    if (!isLikelyBareRepoOwner(owner, currentOwner) && !name.startsWith('.'))
        return true;
    return !name.startsWith('.') && /\.[A-Za-z0-9]{1,8}$/.test(name);
}
function isChecklistItemReference(part) {
    return /^[A-Za-z]-\d+$/.test(part);
}
function isLikelyBareRepoOwner(owner, currentOwner) {
    return owner === currentOwner || owner.includes('-') || owner.includes('.');
}
function mentionsSourceOfTruthSync(normalized) {
    return (/(source[- ]of[- ]truth|upstream|canonical)/.test(normalized) &&
        /(sync|copy|drift|downstream|mirror|vendored)/.test(normalized));
}
function requiresLiveCrossRepositoryAction(issue, currentRepo) {
    const directiveText = requestedActionDirectives(issue);
    if (!directiveText)
        return false;
    const normalizedDirectives = directiveText.toLowerCase();
    const fullText = issueText(issue);
    return (mentionsExternalRepositoryTarget(fullText, fullText.toLowerCase(), currentRepo) &&
        mentionsLiveRepositoryWorkflow(normalizedDirectives));
}
function requestedActionDirectives(issue) {
    const imperative = /^\s*(?:(?:[-*+]|\d+[.)])\s*)?(?:choose|complete|create|dogfood|execute|init(?:ialize)?|merge|open|perform|push|run|select|test|validate)\b/i;
    if (reportsExistingFailure(issue.title))
        return '';
    const directives = (issue.body ?? '').split('\n').filter((line) => imperative.test(line));
    if (imperative.test(issue.title))
        directives.unshift(issue.title);
    return directives.join('\n');
}
function reportsExistingFailure(title) {
    return /\b(?:blocked|bug|cannot|dispatch(?:ed|es|ing)?|fail(?:ed|ing|s|ure)?|invalid|wrong)\b/i.test(title);
}
function mentionsExternalRepositoryTarget(text, normalized, currentRepo) {
    if (referencedUpstreamRepos(text, currentRepo).length > 0)
        return true;
    return (/\b(?:another|different|external|non[- ]node|other|separate)(?:\s+[a-z0-9.+#-]+){0,3}\s+repositor(?:y|ies)\b/.test(normalized) ||
        /\brepositor(?:y|ies)\s+(?:different\s+from|other\s+than|outside)\b/.test(normalized));
}
function mentionsLiveRepositoryWorkflow(normalized) {
    return (/\bkaizen\s+init\b/.test(normalized) ||
        /\bissue\s*(?:→|->|to)\s*(?:pull request|pr)\s*(?:→|->|to)\s*merge\b/.test(normalized) ||
        /\bgit\s+push\b/.test(normalized) ||
        /\b(?:create|merge|open|push)\b[^.\n]{0,40}\b(?:pull request|pr|remote)\b/.test(normalized));
}
function weakensGuardrails(normalized) {
    return /\b(should|must|please|recommend(?:ed)?|expected|suggested)[^.\n]*(remove|drop|delete|disable|skip|relax|weaken)[^.\n]*(safety|guardrail|verification|review|pr guardian|checks?|tests?|approval|feedback)/.test(normalized);
}
function lacksActionableContext(issue) {
    const title = issue.title.trim().toLowerCase();
    const body = issue.body?.trim() ?? '';
    const commentsLength = (issue.comments ?? []).reduce((sum, comment) => sum + comment.body.trim().length, 0);
    const detailsLength = body.length + commentsLength;
    const text = issueText(issue).trim().toLowerCase();
    if (!issue.title.trim() && !text)
        return true;
    if (detailsLength < 40 && /^(fix|bug|fix bug|improve|improve behavior|broken|issue)$/i.test(title))
        return true;
    return /\b(tbd|todo|needs context|more info needed|insufficient details|unknown expected behavior)\b/.test(text);
}
//# sourceMappingURL=issueIntake.js.map