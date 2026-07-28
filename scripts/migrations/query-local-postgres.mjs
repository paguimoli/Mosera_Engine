import { readFileSync } from "node:fs";
import { runPsql } from "./lib/local-migration-utils.mjs";

const separator = process.argv.indexOf("--");
const args = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
const input = process.stdin.isTTY ? undefined : readFileSync(0, "utf8");
const result = runPsql(args, { input });

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
