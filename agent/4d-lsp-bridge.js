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
// 4D-Analyzer VS Code extension's globalStorage (macOS).
//   TOOL4D_ARGS   extra args appended to tool4d (space separated)
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function discoverTool4d() {
	const base = path.join(
		os.homedir(),
		"Library/Application Support/Code/User/globalStorage/4d.4d-analyzer/tool4d",
	);
	let best = null;
	let versions;
	try {
		versions = fs.readdirSync(base);
	} catch {
		return null;
	}
	for (const ver of versions) {
		let builds;
		try {
			builds = fs.readdirSync(path.join(base, ver));
		} catch {
			continue;
		}
		for (const b of builds) {
			const exe = path.join(base, ver, b, "tool4d.app/Contents/MacOS/tool4d");
			try {
				const m = fs.statSync(exe).mtimeMs;
				if (!best || m > best.m) best = { exe, m };
			} catch {
				/* not this build */
			}
		}
	}
	return best && best.exe;
}

const TOOL4D = process.argv[2] || process.env.TOOL4D_BIN || discoverTool4d();
const EXTRA = (process.env.TOOL4D_ARGS || "").trim();

if (!TOOL4D || !fs.existsSync(TOOL4D)) {
	process.stderr.write(
		"4d-lsp-bridge: tool4d not found. Pass its path as the first arg or set TOOL4D_BIN.\n",
	);
	process.exit(2);
}

// tool4d dials back into us; the client listens (same as the 4D-Analyzer extension).
const server = net.createServer(socket => {
	// Relay raw LSP bytes both ways. stdout MUST stay pure LSP — all logs go to stderr.
	socket.pipe(process.stdout);
	process.stdin.pipe(socket);
	const done = () => {
		try {
			socket.destroy();
		} catch {
			/* already gone */
		}
		process.exit(0);
	};
	socket.on("close", done);
	socket.on("error", done);
	server.close(); // one LSP connection is all we need
});

server.on("error", e => {
	process.stderr.write(`4d-lsp-bridge: ${e.message}\n`);
	process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	const args = ["--lsp=" + port, ...(EXTRA ? EXTRA.split(/\s+/) : [])];
	process.stderr.write(
		`4d-lsp-bridge: ${path.basename(TOOL4D)} ${args.join(" ")} (tool4d dials back to :${port})\n`,
	);
	const child = spawn(TOOL4D, args, { stdio: ["ignore", "ignore", "pipe"] });
	child.stderr.on("data", d => process.stderr.write(`[tool4d] ${d}`));
	child.on("exit", code => {
		process.stderr.write(`4d-lsp-bridge: tool4d exited (${code})\n`);
		process.exit(code == null ? 0 : code);
	});
});
