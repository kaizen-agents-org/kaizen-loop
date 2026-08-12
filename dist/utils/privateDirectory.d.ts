export declare const PRIVATE_DIRECTORY_MODE = 448;
export declare function ensurePrivateDirectory(directoryPath: string): Promise<void>;
export declare function makeDirectoryPrivate(directoryPath: string): Promise<void>;
export declare function assertPrivateDirectory(directoryPath: string): Promise<void>;
