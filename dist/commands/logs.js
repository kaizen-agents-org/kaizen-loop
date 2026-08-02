import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { resolveProject } from '../config/registry.js';
import { projectStateDir } from '../utils/paths.js';
export async function readLogs(options) {
    const files = await logFiles(options);
    const chunks = await Promise.all(files.map(readOptional));
    return chunks.filter((chunk) => chunk.length > 0).join('\n\n');
}
export async function followLogs(options) {
    const files = await logFiles(options);
    if (files.length === 0)
        return;
    const write = options.write ?? ((chunk) => process.stdout.write(chunk));
    const positions = new Map();
    const decoders = new Map();
    const intervalMs = options.intervalMs ?? 1000;
    while (!options.signal?.aborted) {
        for (const file of files) {
            const previous = positions.get(file) ?? 0;
            const decoder = decoders.get(file) ?? new StringDecoder('utf8');
            decoders.set(file, decoder);
            positions.set(file, await readAppended(file, previous, decoder, write));
        }
        await delay(intervalMs, options.signal);
    }
}
async function logFiles(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    if (options.guardian)
        return guardianLogFiles(resolved.slug);
    const runsDir = path.join(projectStateDir(resolved.slug), 'runs');
    const run = options.run ?? (await latestRun(runsDir));
    if (!run)
        return [];
    if (!options.issue) {
        return [
            path.join(runsDir, run, 'summary.json'),
            path.join(runsDir, run, 'verifier-runtime.json')
        ];
    }
    const issueDir = path.join(runsDir, run, `issue-${options.issue}`);
    return [
        path.join(runsDir, run, 'verifier-runtime.json'),
        path.join(issueDir, 'agent.log'),
        path.join(issueDir, 'verify.log'),
        path.join(issueDir, 'verifier.log')
    ];
}
async function guardianLogFiles(slug) {
    const jobsDir = path.join(projectStateDir(slug), 'guardian', 'jobs');
    try {
        return (await fs.readdir(jobsDir))
            .filter((file) => file.endsWith('.json'))
            .sort()
            .map((file) => path.join(jobsDir, file));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
async function readOptional(file) {
    try {
        return await fs.readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return '';
        throw error;
    }
}
async function readAppended(file, previous, decoder, write) {
    let stat;
    try {
        stat = await fs.stat(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return previous;
        throw error;
    }
    const offset = stat.size < previous ? 0 : previous;
    if (offset === 0 && previous > 0)
        decoder.end();
    if (stat.size <= offset)
        return offset;
    const length = stat.size - offset;
    const handle = await fs.open(file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead > 0)
            write(decoder.write(buffer.subarray(0, bytesRead)));
        return offset + bytesRead;
    }
    finally {
        await handle.close();
    }
}
async function latestRun(runsDir) {
    try {
        return (await fs.readdir(runsDir)).sort().at(-1);
    }
    catch {
        return undefined;
    }
}
function delay(ms, signal) {
    if (signal?.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        let abort;
        const timer = setTimeout(() => {
            if (abort)
                signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        abort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}
//# sourceMappingURL=logs.js.map