export class KaizenError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'KaizenError';
    this.exitCode = exitCode;
  }
}

export class ConfigError extends KaizenError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'ConfigError';
  }
}
