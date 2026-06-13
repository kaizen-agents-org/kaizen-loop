# kaizen-loop

Kaizen Loop is a local TypeScript CLI that processes GitHub Issues labeled `kaizen` with an AI maintenance agent.

The CLI currently implements:

- `kaizen init`
- `kaizen run`
- `kaizen run --dry-run`
- `kaizen list`
- `kaizen report`
- `kaizen fix <issue>`
- `kaizen status`
- `kaizen enable` / `kaizen disable`
- `kaizen logs`
- `kaizen doctor`

The Phase 2 implementation supports builder-agent based fixes, verifier review, hybrid reflection when verifier is disabled, verification retries, scheduler registration, and basic operational commands. `kaizen watch` remains a later-phase feature.

See [docs/README.md](./docs/README.md) for the full specification.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```
