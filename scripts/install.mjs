#!/usr/bin/env node
/**
 * Link (default) or copy this extension into pi's extension directory.
 *
 *   node scripts/install.mjs           # symlink ~/.pi/agent/extensions/pi-gitlab-duo -> this repo
 *   node scripts/install.mjs --copy    # copy index.ts, package.json, README.md instead
 *
 * After installing, restart pi (or run /reload) and use /login -> GitLab Duo.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const target = join(agentDir, "extensions", "pi-gitlab-duo");
const copy = process.argv.includes("--copy");

mkdirSync(dirname(target), { recursive: true });

const existing = lstatSync(target, { throwIfNoEntry: false });
if (existing) {
	const pointsHere =
		existing.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === repo;
	if (!pointsHere && !process.argv.includes("--force")) {
		console.error(`${target} already exists and is not a link to ${repo}.`);
		console.error("Re-run with --force to replace it.");
		process.exit(1);
	}
	rmSync(target, { recursive: true, force: true });
}

if (copy) {
	mkdirSync(target, { recursive: true });
	for (const file of ["index.ts", "package.json", "README.md"]) {
		const source = join(repo, file);
		if (existsSync(source)) cpSync(source, join(target, file));
	}
	console.log(`Copied to ${target}`);
	console.log("Re-copy after editing the source.");
} else {
	symlinkSync(repo, target, "dir");
	console.log(`Linked ${target} -> ${repo}`);
}

console.log("Restart pi (or /reload), then: /login -> GitLab Duo -> instance URL, personal access token.");
