import { spawnSync } from "node:child_process";

const suite = process.argv[2] ?? "math-evaluator";

const result = spawnSync(
  "dotnet",
  ["test", "services/game-engine/GameEngine.sln", "--no-restore"],
  {
    encoding: "utf8",
    stdio: "pipe",
  },
);

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.status !== 0) {
  console.error(`[${suite}] .NET Game Engine tests failed.`);
  process.exit(result.status ?? 1);
}

console.log(`[${suite}] PASS`);
