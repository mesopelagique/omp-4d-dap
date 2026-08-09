#!/usr/bin/env node
// Installer for the 4D adapters for oh-my-pi (omp): DAP (debug) + LSP (language).
//
// Copies the bridges and writes dap.json / lsp.json with machine-correct ABSOLUTE
// paths into your omp config dir, so nothing is hard-coded to one machine.
//
// Usage:
//   node install.js                          install to ~/.omp/agent
//   node install.js --dir <path>             install into a custom dir
//   OMP_AGENT_DIR=~/.claude node install.js  install for another agent
//
// The runtime you launch this with (node or bun) becomes the command for both
// bridges, so they always run under a runtime that is known to exist here.

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

const required = ["4d-dap-bridge.js", "dap.json", "4d-lsp-bridge.js", "lsp.json"];
for (const f of required) {
	if (!fs.existsSync(path.join(srcDir, f))) {
		console.error(`error: run this from the repo root (missing agent/${f})`);
		process.exit(1);
	}
}

fs.mkdirSync(dest, { recursive: true });

function installBridge(name) {
	const to = path.join(dest, name);
	fs.copyFileSync(path.join(srcDir, name), to);
	try {
		fs.chmodSync(to, 0o755);
	} catch {
		/* non-fatal on filesystems without exec bits */
	}
	return to;
}

// --- DAP (debug) ---
const dapBridge = installBridge("4d-dap-bridge.js");
const dap = JSON.parse(fs.readFileSync(path.join(srcDir, "dap.json"), "utf8"));
dap.adapters["4d"].command = process.execPath;
dap.adapters["4d"].args = [dapBridge, "${port}"];
fs.writeFileSync(path.join(dest, "dap.json"), JSON.stringify(dap, null, 2) + "\n");

// --- LSP (language) ---
const lspBridge = installBridge("4d-lsp-bridge.js");
const lsp = JSON.parse(fs.readFileSync(path.join(srcDir, "lsp.json"), "utf8"));
lsp.servers["4d"].command = process.execPath;
lsp.servers["4d"].args = [lspBridge];
fs.writeFileSync(path.join(dest, "lsp.json"), JSON.stringify(lsp, null, 2) + "\n");

console.log("✓ Installed the 4D adapters for omp");
console.log("  DAP config : " + path.join(dest, "dap.json") + "  (+ 4d-dap-bridge.js)");
console.log("  LSP config : " + path.join(dest, "lsp.json") + "  (+ 4d-lsp-bridge.js)");
console.log("  runtime    : " + process.execPath);
console.log("");
console.log("LSP (code intelligence) works out of the box if the 4D-Analyzer VS Code");
console.log("extension is installed (its bundled tool4d is auto-discovered), or set");
console.log("TOOL4D_BIN to a tool4d executable.");
console.log("");
console.log("DAP (debugging) needs 4D Server (single-user 4D is not supported):");
console.log('  1. "/Applications/4D Server.app/Contents/MacOS/4D Server" --project <MyApp.4DProject> --dap');
console.log("  2. In omp:  debug  action=attach  adapter=4d  port=19815");
