#!/usr/bin/env node
import { run } from './capture.mjs';

process.exitCode = await run();
