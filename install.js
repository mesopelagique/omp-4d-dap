#!/usr/bin/env node
// Installer for the 4D DAP adapter for oh-my-pi (omp).
//
// Copies the bridge and writes a dap.json with machine-correct ABSOLUTE paths
// into your omp user config dir, so nothing is hard-coded to one machine.
//
// Usage:
//   node install.js                          install to ~/.omp/agent
//   node install.js --dir <path>             install into a custom dir
//   OMP_AGENT_DIR=~/.claude node install.js  install for another agent that reads dap.json
//
// The runtime you launch this with (node or bun) becomes the adapter command,
// so the bridge always runs under a runtime that is known to exist here.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function expandHome(p) {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function targetDir() {
	const i = process.argv.indexOf("--dir");
	if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
	if (process.env.OMP_AGENT_DIR) return process.env.OMP_AGENT_DIR;
	return path.join(os.homedir(), ".omp", "agent");
}

const srcDir = path.join(__dirname, "agent");
const dest = path.resolve(expandHome(targetDir()));

const bridgeSrc = path.join(srcDir, "4d-dap-bridge.js");
const configSrc = path.join(srcDir, "dap.json");
if (!fs.existsSync(bridgeSrc) || !fs.existsSync(configSrc)) {
	console.error(`error: run this from the repo root (missing ${srcDir})`);
	process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });

const bridgeDest = path.join(dest, "4d-dap-bridge.js");
fs.copyFileSync(bridgeSrc, bridgeDest);
try {
	fs.chmodSync(bridgeDest, 0o755);
} catch {
	/* non-fatal on filesystems without exec bits */
}

// Keep dap.json as the single source of truth for the adapter fields; only
// rewrite the two machine-specific values so no personal path is committed.
const cfg = JSON.parse(fs.readFileSync(configSrc, "utf8"));
cfg.adapters["4d"].command = process.execPath; // node/bun that ran this installer
cfg.adapters["4d"].args = [bridgeDest, "${port}"];
fs.writeFileSync(path.join(dest, "dap.json"), JSON.stringify(cfg, null, 2) + "\n");

console.log("✓ Installed the 4D DAP adapter for omp");
console.log("  config : " + path.join(dest, "dap.json"));
console.log("  bridge : " + bridgeDest);
console.log("  runtime: " + process.execPath);
console.log("");
console.log("Next:");
console.log("  1. Start 4D Server with DAP enabled (single-user 4D is not supported):");
console.log('       "/Applications/4D Server.app/Contents/MacOS/4D Server" --project <MyApp.4DProject> --dap');
console.log("  2. In omp, use the debug tool:  action=attach  adapter=4d  port=19815");
