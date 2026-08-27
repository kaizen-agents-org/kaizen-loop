let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1_048_576) process.exit(2);
});
process.stdin.on('end', () => {
  let existing;
  try {
    existing = JSON.parse(input);
  } catch {
    process.exit(2);
  }
  if (
    typeof existing?.kaizenHome !== 'string' ||
    !existing.allowedRepositories || Array.isArray(existing.allowedRepositories) ||
    typeof existing.allowedRepositories !== 'object' ||
    !Array.isArray(existing.scheduledJobs) ||
    existing.scheduledJobs.some((entry) => typeof entry?.project !== 'string' || typeof entry?.job !== 'string')
  ) process.exit(2);
  const replaceAll = process.argv[2] === 'true';
  const kaizenHome = process.argv[3];
  const repositoryMarker = process.argv.indexOf('--repositories');
  const jobMarker = process.argv.indexOf('--scheduled-jobs');
  if (repositoryMarker !== 4 || jobMarker < 5) process.exit(2);
  const repositories = process.argv.slice(repositoryMarker + 1, jobMarker);
  const jobs = process.argv.slice(jobMarker + 1).map((entry) => entry.slice(0, entry.lastIndexOf('@')));
  const existingRepositories = Object.keys(existing.allowedRepositories);
  const existingJobs = existing.scheduledJobs.map((entry) => `${entry.project}/${entry.job}`);
  const sorted = (values) => [...new Set(values)].sort();
  const difference = (left, right) => sorted(left.filter((value) => !right.includes(value)));
  const intersection = (left, right) => sorted(left.filter((value) => right.includes(value)));
  const addedJobs = difference(jobs, existingJobs);
  const retainedJobs = intersection(jobs, existingJobs);
  const removedJobs = difference(existingJobs, jobs);
  const addedRepositories = difference(repositories, existingRepositories);
  const retainedRepositories = intersection(repositories, existingRepositories);
  const removedRepositories = difference(existingRepositories, repositories);
  const homeChanged = typeof existing?.kaizenHome === 'string' && existing.kaizenHome !== kaizenHome;
  const format = (values) => values.length > 0 ? values.join(', ') : 'none';
  console.log(`Broker jobs: added=${format(addedJobs)}; retained=${format(retainedJobs)}; removed=${format(removedJobs)}`);
  console.log(`Broker repositories: added=${format(addedRepositories)}; retained=${format(retainedRepositories)}; removed=${format(removedRepositories)}`);
  console.log(`Kaizen home: ${homeChanged ? `${existing.kaizenHome} -> ${kaizenHome}` : 'retained'}`);
  if (!replaceAll && (removedJobs.length > 0 || removedRepositories.length > 0 || homeChanged)) {
    console.error('Refusing to remove broker jobs/repositories or replace kaizenHome without --replace-all.');
    process.exit(3);
  }
});
