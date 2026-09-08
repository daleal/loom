import { mkdir, open, readFile, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { regex } from 'arkregex';

const newlinePattern = regex('\r?\n');

/** Serialize changes to configuration and the shared checkout. */
export const withWorkspaceLock = async <Result>(
  directory: string,
  action: () => Promise<Result>,
): Promise<Result> => {
  const cache = join(directory, '.loom');
  await mkdir(cache, { recursive: true });
  const lock = join(cache, 'lock');
  let handle;
  try {
    handle = await open(lock, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        'Another Loom command may be running. If it was interrupted, remove .loom/lock before retrying.',
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(String(process.pid));
    return await action();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
};

export const ignoreCache = async (directory: string): Promise<void> => {
  const path = join(directory, '.gitignore');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (
    text
      .split(newlinePattern)
      .some((line) => ['.loom', '.loom/', '/.loom', '/.loom/'].includes(line.trim()))
  )
    return;
  await appendFile(path, `${text && !text.endsWith('\n') ? '\n' : ''}/.loom/\n`);
};
