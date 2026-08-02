import { z } from 'zod';
export declare const DEFAULT_PROTECTED_PATHS: string[];
export declare const DEFAULT_FORBIDDEN_PATHS: string[];
declare const schedulerScheduleSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"interval">;
    everyMinutes: z.ZodOptional<z.ZodNumber>;
    everyHours: z.ZodOptional<z.ZodNumber>;
    anchorTime: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"times">;
    times: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"daily">;
    time: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"weekly">;
    days: z.ZodArray<z.ZodEnum<{
        MO: "MO";
        TU: "TU";
        WE: "WE";
        TH: "TH";
        FR: "FR";
        SA: "SA";
        SU: "SU";
    }>>;
    time: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"rrule">;
    value: z.ZodString;
}, z.core.$strict>], "type">;
declare const schedulerRunSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    mode: z.ZodLiteral<"maintenance">;
    lateStartGuard: z.ZodDefault<z.ZodBoolean>;
    maxIssues: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"watch">;
    skipIfRunning: z.ZodDefault<z.ZodBoolean>;
    maxIssues: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"smoke">;
}, z.core.$strict>], "mode">;
declare const schedulerJobSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"interval">;
        everyMinutes: z.ZodOptional<z.ZodNumber>;
        everyHours: z.ZodOptional<z.ZodNumber>;
        anchorTime: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"times">;
        times: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"daily">;
        time: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"weekly">;
        days: z.ZodArray<z.ZodEnum<{
            MO: "MO";
            TU: "TU";
            WE: "WE";
            TH: "TH";
            FR: "FR";
            SA: "SA";
            SU: "SU";
        }>>;
        time: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"rrule">;
        value: z.ZodString;
    }, z.core.$strict>], "type">;
    run: z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"maintenance">;
        lateStartGuard: z.ZodDefault<z.ZodBoolean>;
        maxIssues: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"watch">;
        skipIfRunning: z.ZodDefault<z.ZodBoolean>;
        maxIssues: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"smoke">;
    }, z.core.$strict>], "mode">;
}, z.core.$strict>;
export declare const configSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    agent: z.ZodDefault<z.ZodObject<{
        default: z.ZodDefault<z.ZodEnum<{
            claude: "claude";
            codex: "codex";
        }>>;
        fallback: z.ZodDefault<z.ZodBoolean>;
        model: z.ZodDefault<z.ZodObject<{
            claude: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            codex: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    run: z.ZodDefault<z.ZodObject<{
        maxIssuesPerNight: z.ZodDefault<z.ZodNumber>;
        issueTimeoutMinutes: z.ZodDefault<z.ZodNumber>;
        runTimeoutMinutes: z.ZodDefault<z.ZodNumber>;
        maxVerifyRetries: z.ZodDefault<z.ZodNumber>;
        maxAttemptsPerIssue: z.ZodDefault<z.ZodNumber>;
        maxOpenPullRequests: z.ZodDefault<z.ZodNumber>;
        latestStartHour: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    safety: z.ZodDefault<z.ZodObject<{
        operationMode: z.ZodDefault<z.ZodEnum<{
            external: "external";
            dogfood: "dogfood";
        }>>;
        minFreeDiskMb: z.ZodDefault<z.ZodNumber>;
        wipLimit: z.ZodDefault<z.ZodNumber>;
        envAllowlist: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    scheduler: z.ZodDefault<z.ZodObject<{
        provider: z.ZodOptional<z.ZodEnum<{
            external: "external";
            launchd: "launchd";
            cron: "cron";
            "codex-automation": "codex-automation";
            "claude-routine": "claude-routine";
        }>>;
        jobs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"interval">;
                everyMinutes: z.ZodOptional<z.ZodNumber>;
                everyHours: z.ZodOptional<z.ZodNumber>;
                anchorTime: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"times">;
                times: z.ZodArray<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"daily">;
                time: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"weekly">;
                days: z.ZodArray<z.ZodEnum<{
                    MO: "MO";
                    TU: "TU";
                    WE: "WE";
                    TH: "TH";
                    FR: "FR";
                    SA: "SA";
                    SU: "SU";
                }>>;
                time: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"rrule">;
                value: z.ZodString;
            }, z.core.$strict>], "type">;
            run: z.ZodDiscriminatedUnion<[z.ZodObject<{
                mode: z.ZodLiteral<"maintenance">;
                lateStartGuard: z.ZodDefault<z.ZodBoolean>;
                maxIssues: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"watch">;
                skipIfRunning: z.ZodDefault<z.ZodBoolean>;
                maxIssues: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>, z.ZodObject<{
                mode: z.ZodLiteral<"smoke">;
            }, z.core.$strict>], "mode">;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    commands: z.ZodDefault<z.ZodObject<{
        setup: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        verify: z.ZodDefault<z.ZodArray<z.ZodString>>;
        verifyTimeoutMinutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    builder: z.ZodDefault<z.ZodObject<{
        command: z.ZodDefault<z.ZodString>;
        resultPath: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
    verifier: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        command: z.ZodDefault<z.ZodString>;
        resultPath: z.ZodDefault<z.ZodString>;
        timeoutMinutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    guardian: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        mode: z.ZodDefault<z.ZodEnum<{
            sync: "sync";
            async: "async";
        }>>;
        command: z.ZodDefault<z.ZodString>;
        timeoutMinutes: z.ZodDefault<z.ZodNumber>;
        maxAttempts: z.ZodDefault<z.ZodNumber>;
        reviewSettleSeconds: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    goal: z.ZodDefault<z.ZodObject<{
        maxIterations: z.ZodDefault<z.ZodNumber>;
        issueLabel: z.ZodDefault<z.ZodString>;
        evaluation: z.ZodDefault<z.ZodObject<{
            command: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            timeoutMinutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        agent: z.ZodDefault<z.ZodObject<{
            command: z.ZodDefault<z.ZodString>;
            args: z.ZodDefault<z.ZodArray<z.ZodString>>;
            resultPath: z.ZodDefault<z.ZodString>;
            timeoutMinutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    policy: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<{
            hybrid: "hybrid";
            "pr-only": "pr-only";
            "direct-only": "direct-only";
        }>>;
        directCommit: z.ZodDefault<z.ZodObject<{
            maxChangedLines: z.ZodDefault<z.ZodNumber>;
            maxChangedFiles: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        protectedPaths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        forbiddenPaths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    git: z.ZodDefault<z.ZodObject<{
        defaultBranch: z.ZodDefault<z.ZodString>;
        branchPrefix: z.ZodDefault<z.ZodString>;
        commitMessageFormat: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
    instant: z.ZodDefault<z.ZodObject<{
        unattendedMode: z.ZodDefault<z.ZodEnum<{
            pr: "pr";
            direct: "direct";
            reject: "reject";
        }>>;
    }, z.core.$strict>>;
    report: z.ZodDefault<z.ZodObject<{
        notification: z.ZodDefault<z.ZodBoolean>;
        issueComments: z.ZodDefault<z.ZodBoolean>;
        starvationRuns: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    issues: z.ZodDefault<z.ZodObject<{
        label: z.ZodDefault<z.ZodString>;
        executionAuthorization: z.ZodDefault<z.ZodObject<{
            label: z.ZodDefault<z.ZodString>;
            minimumPermission: z.ZodDefault<z.ZodEnum<{
                triage: "triage";
                write: "write";
                maintain: "maintain";
                admin: "admin";
            }>>;
        }, z.core.$strict>>;
        selection: z.ZodDefault<z.ZodObject<{
            mode: z.ZodDefault<z.ZodEnum<{
                auto: "auto";
                "opt-in": "opt-in";
                "manual-only": "manual-only";
            }>>;
            includeLabel: z.ZodDefault<z.ZodString>;
            excludeLabels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        priorityOrder: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type KaizenConfig = z.infer<typeof configSchema>;
export type SchedulerSchedule = z.infer<typeof schedulerScheduleSchema>;
export type SchedulerRun = z.infer<typeof schedulerRunSchema>;
export type SchedulerJobConfig = z.infer<typeof schedulerJobSchema>;
export declare const registryProjectSchema: z.ZodObject<{
    repo: z.ZodString;
    localPath: z.ZodString;
    workspacePath: z.ZodString;
    schedule: z.ZodString;
    enabled: z.ZodBoolean;
    createdAt: z.ZodString;
    lastRun: z.ZodOptional<z.ZodObject<{
        startedAt: z.ZodString;
        finishedAt: z.ZodString;
        result: z.ZodString;
        processed: z.ZodNumber;
        fixed: z.ZodNumber;
        prCreated: z.ZodNumber;
        failed: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const registrySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    projects: z.ZodRecord<z.ZodString, z.ZodObject<{
        repo: z.ZodString;
        localPath: z.ZodString;
        workspacePath: z.ZodString;
        schedule: z.ZodString;
        enabled: z.ZodBoolean;
        createdAt: z.ZodString;
        lastRun: z.ZodOptional<z.ZodObject<{
            startedAt: z.ZodString;
            finishedAt: z.ZodString;
            result: z.ZodString;
            processed: z.ZodNumber;
            fixed: z.ZodNumber;
            prCreated: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Registry = z.infer<typeof registrySchema>;
export type RegistryProject = z.infer<typeof registryProjectSchema>;
export {};
