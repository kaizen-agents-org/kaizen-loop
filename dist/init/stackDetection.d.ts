export interface VerifyCommandProposal {
    command: string;
    packageScript?: string;
}
export interface StackDetectionRule {
    id: 'node' | 'python' | 'go' | 'rust' | 'ruby';
    manifest: string;
    setup: string;
    verify: readonly VerifyCommandProposal[];
}
/**
 * Ordered, reusable contract for manifest-based command proposals.
 *
 * The first valid manifest wins. Keep this data-only so verifier and other
 * consumers can import the same policy without depending on filesystem logic.
 */
export declare const STACK_DETECTION_TABLE: readonly StackDetectionRule[];
