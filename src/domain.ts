import { regex } from 'arkregex';

const threadNamePattern = regex('^[a-zA-Z0-9][a-zA-Z0-9._-]*$');
const sourcePattern = regex(
  '^(?<repository>[a-zA-Z0-9][a-zA-Z0-9-]*/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)(?::(?<branch>.+))?$',
);
const invalidBranchCharacterPattern = regex('[\\s~^:?*[\\\\]');

export type Thread = {
  name: string;
  applied: { revision: string } | null;
};

export type LoomConfig = {
  source: string;
  agent?: string;
  model?: string;
  threads: Thread[];
};

export type ConfigKey = 'agent' | 'model';

export type ConfigStore = {
  create(config: LoomConfig): Promise<void>;
  read(): Promise<LoomConfig>;
  set(key: ConfigKey, value: string | undefined): Promise<void>;
  append(names: string[]): Promise<void>;
  markApplied(name: string, revision: string): Promise<void>;
};

export type ThreadSnapshot = {
  revision: string;
  directory: string;
};

export type ThreadRepository = {
  resolve(source: string): Promise<ThreadSnapshot>;
  validate(snapshot: ThreadSnapshot, names: string[]): Promise<void>;
};

export type AgentTask = {
  projectDirectory: string;
  threadDirectory: string;
  name: string;
  model?: string;
};

/** Resolve only on successful completion; reject on failure or interruption. */
export type AgentAdapter = {
  isModelValid(model: string): Promise<boolean>;
  run(task: AgentTask): Promise<void>;
};

export const validateThreadName = (name: string): void => {
  if (!threadNamePattern.test(name)) {
    throw new Error(`Invalid thread name: ${name}. Expected a root directory name.`);
  }
};

export const parseSource = (source: string): { repository: string; branch: string } => {
  const match = sourcePattern.exec(source);
  if (!match) throw new Error('Expected a source like owner/repo or owner/repo:branch.');
  const { repository, branch = 'main' } = match.groups;
  // Git ref rules, including slash-separated branch names.
  if (
    invalidBranchCharacterPattern.test(branch) ||
    [...branch].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch === '@' ||
    branch.endsWith('.') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new Error(`Invalid branch: ${branch}`);
  }
  return { repository, branch };
};
