export function isProjectSlug(slug: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug) && !slug.includes('..');
}

export function assertProjectSlug(slug: string): void {
  if (!isProjectSlug(slug)) {
    throw new Error(`Invalid Kaizen project slug: ${slug}`);
  }
}

export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  return slug.length > 0 ? slug : 'issue';
}

export function slugFromRepo(repo: string): string {
  const slug = repo.replace(/\//g, '-');
  assertProjectSlug(slug);
  return slug;
}

export function repoFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (https) return https[1];

  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh) return ssh[1];

  return undefined;
}
