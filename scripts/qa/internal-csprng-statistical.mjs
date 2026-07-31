import { spawnSync } from "node:child_process";

const result = spawnSync(
  "dotnet",
  [
    "run",
    "--project",
    "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
    "--no-build",
    "--",
    "internal-csprng-provider",
  ],
  {
    encoding: "utf8",
    stdio: "pipe",
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
if (!result.stdout.includes("samples=100000")) {
  throw new Error("Internal CSPRNG statistical evidence was not produced.");
}

console.log("[internal-csprng-statistical] PASS");
