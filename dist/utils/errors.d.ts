export declare class KaizenError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode?: number);
}
export declare class ConfigError extends KaizenError {
    constructor(message: string);
}
