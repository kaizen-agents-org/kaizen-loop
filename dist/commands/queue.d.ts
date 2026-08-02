import type { GitHubIssue } from '../github/types.js';
import type { CommandRunner } from '../utils/command.js';
export interface QueueOptions {
    cwd: string;
    project?: string;
    issues: number[];
    runCommand: CommandRunner;
}
export interface QueueListOptions {
    cwd: string;
    project?: string;
    runCommand: CommandRunner;
}
export declare function queueIssues(options: QueueOptions): Promise<{
    queued: number[];
    labels: string[];
}>;
export declare function unqueueIssues(options: QueueOptions): Promise<{
    unqueued: number[];
    label: string;
}>;
export declare function listQueuedIssues(options: QueueListOptions): Promise<{
    label: string;
    issues: GitHubIssue[];
}>;
