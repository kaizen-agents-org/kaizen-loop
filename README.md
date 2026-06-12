# kaizen-loop

Kaizen Loop is a local TypeScript CLI that processes GitHub Issues labeled `kaizen` with an AI maintenance agent.

The Phase 1 MVP implements:

- `kaizen init`
- `kaizen run`
- `kaizen run --dry-run`
- `kaizen list`

Phase 1 always creates pull requests. Scheduler registration, direct commits, Codex execution, retry loops, instant fixes, and status/log/doctor commands are planned for later phases.

See [docs/README.md](./docs/README.md) for the full specification.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```
