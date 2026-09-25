#!/usr/bin/env node
import { runCli } from './index';

const result = runCli(process.argv.slice(2), { cliDir: __dirname });
if (result.stdout !== '') process.stdout.write(result.stdout);
process.exit(result.exitCode);
