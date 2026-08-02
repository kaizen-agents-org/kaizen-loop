import type { CommandRunner } from '../utils/command.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';
export declare class CodexAdapter implements AgentAdapter {
    private readonly runCommand;
    readonly name: "codex";
    constructor(runCommand: CommandRunner);
    isAvailable(): Promise<boolean>;
    run(req: AgentRequest): Promise<AgentResult>;
}
