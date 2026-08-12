export interface PrivateDirectoryRepairResult {
    contentsMayHaveBeenExposed: boolean;
}
export declare function ensurePrivateDirectory(directory: string, options?: {
    beforeExposureRepair?: () => Promise<void>;
}): Promise<PrivateDirectoryRepairResult>;
export declare function ensurePrivateStructureDirectory(directory: string): Promise<void>;
export declare function assertPrivateDirectory(directory: string): Promise<void>;
export declare function privateDirectoryContentsMayHaveBeenExposed(directory: string): Promise<boolean>;
