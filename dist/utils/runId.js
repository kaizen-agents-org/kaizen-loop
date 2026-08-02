export function toRunId(date) {
    return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}
//# sourceMappingURL=runId.js.map