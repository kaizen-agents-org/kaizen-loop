# kaizen-loop

Kaizen Loop is a local TypeScript CLI that processes GitHub Issues labeled `kaizen` with an AI maintenance agent.

The CLI currently implements:

- `kaizen init`
- `kaizen run`
- `kaizen run --dry-run`
- `kaizen list`
- `kaizen report`
- `kaizen queue` / `kaizen unqueue`
- `kaizen fix <issue>`
- `kaizen improve`
- `kaizen status`
- `kaizen enable` / `kaizen disable`
- `kaizen logs`
- `kaizen doctor`

The Phase 2 implementation supports builder-agent-based fixes, verifier review, isolated per-issue git worktrees, parallel issue processing, PR creation followed by the vendored `pr-guardian` skill, hybrid reflection when verifier is disabled, verification retries, YAML-configured nightly/poll scheduler registration, opt-in issue queueing, user-triggered backlog improvement runs, and basic operational commands. `kaizen watch` remains a later-phase feature.

See [docs/README.md](./docs/README.md) for the full specification.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```
