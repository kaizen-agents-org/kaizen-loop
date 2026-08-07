import type { KaizenConfig } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';
export declare function doctorProject(options: {
    cwd: string;
    project?: string;
    repair?: boolean;
    runCommand: CommandRunner;
}): Promise<{
    runtime: import("../utils/runtime.js").RuntimeIdentity;
    slug: string;
    configuration: {
        source: "local" | "workspace";
        path: string;
        drift: {
            detected: boolean;
            localPath: string;
            workspacePath: string;
            message: string | undefined;
        } | undefined;
    };
    checks: {
        name: string;
        ok: boolean;
        message?: string;
    }[];
    ok: boolean;
}>;
export declare function requiredLabels(config: KaizenConfig): string[];
