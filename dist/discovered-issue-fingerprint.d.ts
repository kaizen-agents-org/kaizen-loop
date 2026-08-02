export interface DiscoveredIssueFingerprint {
    marker: string;
    searchTerm: string;
    normalizedEvidence: string;
    failureClass?: string;
}
export declare function buildDiscoveredIssueFingerprint(options: {
    repo?: string;
    evidence?: string;
    failureClass?: string;
}): DiscoveredIssueFingerprint | undefined;
export declare function parseFailureClass(input?: string): string | undefined;
export declare function normalizeEvidence(input: string): string;
export declare function extractEvidence(body?: string): string | undefined;
export declare function hasDiscoveredIssueMarker(body?: string): boolean;
export declare function hasDiscoveredIssueFingerprint(body: string | undefined, marker: string): boolean;
