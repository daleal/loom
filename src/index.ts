#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execute } from '@oclif/core';
import type { Interfaces } from '@oclif/core';

const args = process.argv.slice(2);
const root = new URL('../', import.meta.url);
const pjson: Interfaces.PJSON = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await execute({
  loadOptions: {
    root: fileURLToPath(root),
    pjson: {
      ...pjson,
      oclif: {
        ...pjson.oclif,
        commands: fileURLToPath(new URL('./cli/commands', import.meta.url)),
      },
    },
  },
  args: args.length ? args : ['--help'],
});
