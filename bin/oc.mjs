#!/usr/bin/env node
/**
 * oc entry point.
 *
 * Kept deliberately thin: resolve the CLI, run it, and translate a thrown error
 * into a message and an exit code. A stack trace is for developers; a user
 * running a code-reading tool wants to know which path failed and what to do.
 */

import { main } from '../src/cli.mjs';

process.on('unhandledRejection', (error) => {
  process.stderr.write(`oc: unexpected error: ${error?.message ?? error}\n`);
  process.exit(1);
});

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error?.message ?? String(error);
  process.stderr.write(`oc: ${message}\n`);
  if (process.env.OC_DEBUG) process.stderr.write(`${error?.stack ?? ''}\n`);
  else process.stderr.write('    set OC_DEBUG=1 for a stack trace\n');
  process.exitCode = 1;
}
