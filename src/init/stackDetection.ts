export interface VerifyCommandProposal {
  command: string;
  packageScript?: string;
}

export interface StackDetectionRule {
  id: 'node' | 'python' | 'go' | 'rust' | 'ruby';
  manifest: string;
  setup: string;
  verify: readonly VerifyCommandProposal[];
}

/**
 * Ordered, reusable contract for manifest-based command proposals.
 *
 * The first valid manifest wins. Keep this data-only so verifier and other
 * consumers can import the same policy without depending on filesystem logic.
 */
export const STACK_DETECTION_TABLE: readonly StackDetectionRule[] = [
  {
    id: 'node',
    manifest: 'package.json',
    setup: 'npm ci',
    verify: [
      { packageScript: 'test', command: 'npm test' },
      { packageScript: 'lint', command: 'npm run lint' },
      { packageScript: 'build', command: 'npm run build' }
    ]
  },
  {
    id: 'python',
    manifest: 'pyproject.toml',
    setup: 'python -m pip install -e .',
    verify: [
      { command: 'python -m pytest' },
      { command: 'python -m ruff check .' }
    ]
  },
  {
    id: 'go',
    manifest: 'go.mod',
    setup: 'go mod download',
    verify: [
      { command: 'go test ./...' },
      { command: 'go vet ./...' }
    ]
  },
  {
    id: 'rust',
    manifest: 'Cargo.toml',
    setup: 'cargo fetch',
    verify: [
      { command: 'cargo test' },
      { command: 'cargo clippy' }
    ]
  },
  {
    id: 'ruby',
    manifest: 'Gemfile',
    setup: 'bundle install',
    verify: [
      { command: 'bundle exec rake' },
      { command: 'bundle exec rspec' }
    ]
  }
];
