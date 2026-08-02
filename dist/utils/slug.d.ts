export declare function isProjectSlug(slug: string): boolean;
export declare function assertProjectSlug(slug: string): void;
export declare function slugify(input: string, maxLength?: number): string;
export declare function slugFromRepo(repo: string): string;
export declare function repoFromRemote(remote: string): string | undefined;
