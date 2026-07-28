/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("node:module");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const entry = process.argv[2];

if (!entry) {
  throw new Error("A compiled worker entrypoint is required.");
}

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    return originalResolveFilename(
      path.join(root, "worker-dist", request.slice(2)),
      parent,
      isMain,
      options
    );
  }

  return originalResolveFilename(request, parent, isMain, options);
};

process.argv = [
  process.argv[0],
  path.resolve(root, "worker-dist", entry),
  ...process.argv.slice(3),
];

require(process.argv[1]);
