#!/usr/bin/env node
// 4D LSP bridge for oh-my-pi (omp).
//
// WHY THIS EXISTS
// ----------------
// omp speaks LSP over a spawned server's stdio (its lsp.json has no port/tcp
// option). 4D's language server (`tool4d --lsp=PORT`) instead uses a REVERSE TCP
// connection — the *client* listens on a port and tool4d dials back into it
// ("Use a TCP socket because of problems with blocking STDIO", per 4D-Analyzer).
//
// So this bridge is a stdio <-> reverse-TCP relay: it listens on a loopback port,
// spawns `tool4d --lsp=<port>`, waits for tool4d to connect back, then pipes
// omp's stdin/stdout to that socket. tool4d loads the project from the LSP
// `initialize` rootUri (omp sends the workspace), so no --project is needed.
//
// USAGE (wired up by lsp.json):   node 4d-lsp-bridge.js [tool4dPath]
//
// tool4d path resolution: argv[2]  →  $TOOL4D_BIN  →  newest tool4d under the
// 4D-Analyzer installation (macOS/Windows globalStorage; Linux /opt/tool4d).
//   TOOL4D_ARGS   extra args appended to tool4d (space separated)
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function optionalPath(operation) {
	try {
		return operation();
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
		throw error;
	}
}

function discoverTool4d({
	platform = process.platform,
	home = os.homedir(),
	env = process.env,
} = {}) {
	if (platform === "linux") {
		const exe = "/opt/tool4d/tool4d";
		return optionalPath(() => fs.statSync(exe))?.isFile() ? exe : null;
	}
	const storage = platform === "darwin"
		? path.join(home, "Library", "Application Support")
		: platform === "win32"
			? env.APPDATA || path.join(home, "AppData", "Roaming")
			: null;
	if (!storage) return null;
	const executable = platform === "win32"
		? path.join("tool4d", "tool4d.exe")
		: path.join("tool4d.app", "Contents", "MacOS", "tool4d");
	let best = null;
	for (const editor of ["Code", "Code - Insiders"]) {
		const base = path.join(storage, editor, "User", "globalStorage",
			"4d.4d-analyzer", "tool4d");
		for (const ver of optionalPath(() => fs.readdirSync(base)) || []) {
			const versionDir = path.join(base, ver);
			for (const build of optionalPath(() => fs.readdirSync(versionDir)) || []) {
				const buildDir = path.join(versionDir, build);
				// Analyzer also checks a nested tool4d folder for cached builds.
				for (const root of [buildDir, path.join(buildDir, "tool4d")]) {
					const exe = path.join(root, executable);
					const stat = optionalPath(() => fs.statSync(exe));
					if (stat?.isFile() && (!best || stat.mtimeMs > best.m)) {
						best = { exe, m: stat.mtimeMs };
					}
				}
			}
		}
	}
	return best && best.exe;
}

function main() {
	const TOOL4D = process.argv[2] || process.env.TOOL4D_BIN || discoverTool4d();
	const EXTRA = (process.env.TOOL4D_ARGS || "").trim();
	if (!TOOL4D || !fs.existsSync(TOOL4D)) {
		process.stderr.write(
			"4d-lsp-bridge: tool4d not found. Pass its path as the first arg or set TOOL4D_BIN.\n",
		);
		process.exit(2);
	}

	const server = net.createServer(socket => {
		// stdout MUST stay pure LSP; all logs go to stderr.
		socket.pipe(process.stdout);
		process.stdin.pipe(socket);
		socket.on("close", () => process.exit(0));
		socket.on("error", error => {
			process.stderr.write(`4d-lsp-bridge: ${error.message}\n`);
			process.exit(1);
		});
		server.close(); // one LSP connection is all we need
	});
	server.on("error", error => {
		process.stderr.write(`4d-lsp-bridge: ${error.message}\n`);
		process.exit(1);
	});
	server.listen(0, "127.0.0.1", () => {
		const port = server.address().port;
		const args = ["--lsp=" + port, ...(EXTRA ? EXTRA.split(/\s+/) : [])];
		process.stderr.write(
			`4d-lsp-bridge: ${path.basename(TOOL4D)} ${args.join(" ")} (tool4d dials back to :${port})\n`,
		);
		const launchError = error => {
			process.stderr.write(`4d-lsp-bridge: cannot launch ${TOOL4D}: ${error.message}\n`);
			process.exit(1);
		};
		let child;
		try {
			child = spawn(TOOL4D, args, { stdio: ["ignore", "ignore", "pipe"] });
		} catch (error) {
			launchError(error);
			return;
		}
		child.on("error", launchError);
		process.on("exit", () => child.kill());
		child.stderr.on("data", d => process.stderr.write(`[tool4d] ${d}`));
		child.on("exit", code => {
			process.stderr.write(`4d-lsp-bridge: tool4d exited (${code})\n`);
			process.exit(code == null ? 1 : code);
		});
	});
}

module.exports = { discoverTool4d };
if (require.main === module) main();
