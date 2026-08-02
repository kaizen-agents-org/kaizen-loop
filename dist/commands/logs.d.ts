interface LogOptions {
    cwd: string;
    project?: string;
    run?: string;
    issue?: number;
    guardian?: boolean;
}
export declare function readLogs(options: LogOptions): Promise<string>;
export declare function followLogs(options: LogOptions & {
    intervalMs?: number;
    signal?: AbortSignal;
    write?: (chunk: string) => void;
}): Promise<void>;
export {};
