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
  return repo.replace(/\//g, '-');
}

export function repoFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
  if (https) return https[1];

  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
  if (ssh) return ssh[1];

  return undefined;
}
