export class KaizenError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.name = 'KaizenError';
        this.exitCode = exitCode;
    }
}
export class ConfigError extends KaizenError {
    constructor(message) {
        super(message, 2);
        this.name = 'ConfigError';
    }
}
//# sourceMappingURL=errors.js.map