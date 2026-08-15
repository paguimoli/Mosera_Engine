import { spawnSync } from "node:child_process";

const mode = process.argv[2] === "extended" ? "extended" : "fast";
const assembly =
  "services/game-engine/tests/GameEngine.CsprngQualification/bin/Release/net10.0/GameEngine.CsprngQualification.dll";

const qualification = spawnSync(
  "dotnet",
  [assembly, mode, "--fail-on-blocker"],
  { encoding: "utf8", stdio: "pipe" },
);
if (qualification.stdout) process.stdout.write(qualification.stdout);
if (qualification.stderr) process.stderr.write(qualification.stderr);
process.exit(qualification.status ?? 1);
