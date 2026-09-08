import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import type { ThreadRepository, ThreadSnapshot } from './domain';
import { parseSource, validateThreadName } from './domain';
import { exists } from './filesystem';
import type { CommandRunner } from './process';

export class GitHubThreadRepository implements ThreadRepository {
  constructor(
    private readonly cacheDirectory: string,
    private readonly commands: CommandRunner,
  ) {}

  async resolve(source: string): Promise<ThreadSnapshot> {
    const { repository, branch } = parseSource(source);
    const directory = join(this.cacheDirectory, ...repository.split('/'));
    await mkdir(directory, { recursive: true });
    const git = (args: string[]) => this.commands.run('git', args, { cwd: directory });
    if (!(await exists(join(directory, '.git')))) await git(['init']);
    await git([
      'fetch',
      '--depth=1',
      '--no-tags',
      `https://github.com/${repository}.git`,
      `refs/heads/${branch}`,
    ]);
    const revision = await git(['rev-parse', 'FETCH_HEAD^{commit}']);
    await git(['checkout', '--detach', '--force', revision]);
    await git(['clean', '-fdx']);
    return { directory, revision };
  }

  async validate(snapshot: ThreadSnapshot, names: string[]): Promise<void> {
    const invalid: string[] = [];
    const root = await realpath(snapshot.directory);
    for (const name of names) {
      validateThreadName(name);
      try {
        const directory = join(root, name);
        if (!(await lstat(directory)).isDirectory()) throw new Error('Not a directory');
        const instructions = join(directory, 'INSTRUCTIONS.md');
        const resolved = relative(directory, await realpath(instructions));
        if (
          resolved.startsWith('..') ||
          isAbsolute(resolved) ||
          !(await lstat(instructions)).isFile()
        ) {
          throw new Error('Not an instructions file');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error;
        invalid.push(name);
      }
    }
    if (invalid.length)
      throw new Error(`Missing thread directories or INSTRUCTIONS.md: ${invalid.join(', ')}`);
  }
}
