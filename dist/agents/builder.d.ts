import { type CommandRunner } from '../utils/command.js';
import type { AgentAdapter, AgentRequest, AgentResult } from './types.js';
export interface BuilderAgentOptions {
    command: string;
    resultPath: string;
    envAllowlist: string[];
}
export declare class BuilderAgentAdapter implements AgentAdapter {
    private readonly runCommand;
    private readonly options;
    readonly name: "builder";
    constructor(runCommand: CommandRunner, options: BuilderAgentOptions);
    isAvailable(): Promise<boolean>;
    run(req: AgentRequest): Promise<AgentResult>;
}
