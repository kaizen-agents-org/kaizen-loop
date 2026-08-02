import type { CommandRunner } from '../utils/command.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';
export declare class ClaudeCodeAdapter implements AgentAdapter {
    private readonly runCommand;
    readonly name: "claude";
    constructor(runCommand: CommandRunner);
    isAvailable(): Promise<boolean>;
    run(req: AgentRequest): Promise<AgentResult>;
}
export declare function parseAgentResult(raw: string, durationMs?: number): AgentResult;
