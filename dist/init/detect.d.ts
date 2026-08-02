export declare function detectCommands(repoDir: string): Promise<{
    setup: string | null;
    verify: string[];
}>;
