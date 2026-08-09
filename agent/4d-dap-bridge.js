#!/usr/bin/env node
// 4D DAP bridge for oh-my-pi (omp).
//
// WHY THIS EXISTS
// ----------------
// omp's `tcp` connectMode reserves a RANDOM local port, substitutes it into
// this adapter's args as ${port}, spawns us, waits until our stdout prints
// that port number, then opens ONE DAP connection to it.
//
// 4D's own DAP server (`4D --dap`) listens on a FIXED port (default 19815) that
// omp cannot choose. This process bridges omp's random port -> 4D's 19815 so
// the standard omp `debug` tool can drive a 4D debug session.
//
// USAGE (wired up by dap.json):   node 4d-dap-bridge.js <localPort>
//
// ENV
//   FOURD_DAP_HOST   4D DAP host                              (default 127.0.0.1)
//   FOURD_DAP_PORT   4D DAP port to forward to                (default 19815)
//   FOURD_BIN        path to 4D Server (DAP works with 4D Server, not single-user
//                    4D)   (default /Applications/4D Server.app/Contents/MacOS/4D Server)
//   FOURD_PROJECT    if set, auto-launch this .4DProject headless with --dap
//                    when nothing is already listening on FOURD_DAP_PORT
//   FOURD_ARGS       extra args appended to 4D on auto-launch (space separated)

const net = require("node:net");
const { spawn } = require("node:child_process");

const localPort = Number(process.argv[2]);
if (!Number.isInteger(localPort) || localPort <= 0) {
	console.error("4d-dap-bridge: missing/invalid local port argument");
	process.exit(2);
}

const DAP_HOST = process.env.FOURD_DAP_HOST || "127.0.0.1";
const DAP_PORT = Number(process.env.FOURD_DAP_PORT || 19815);
const FOURD_BIN = process.env.FOURD_BIN || "/Applications/4D Server.app/Contents/MacOS/4D Server";
const PROJECT = process.env.FOURD_PROJECT || "";
const EXTRA = (process.env.FOURD_ARGS || "").trim();

function canConnect(host, port, timeout = 500) {
	return new Promise(resolve => {
		const s = net.connect({ host, port });
		let done = false;
		const finish = ok => {
			if (!done) {
				done = true;
				s.destroy();
				resolve(ok);
			}
		};
		s.setTimeout(timeout);
		s.once("connect", () => finish(true));
		s.once("timeout", () => finish(false));
		s.once("error", () => finish(false));
	});
}

let launched = false;
function launch4D() {
	if (launched) return;
	launched = true;
	// Open the project's real data (creating it if absent) so you debug the
	// actual application; --headless keeps the bridge-spawned server UI-less.
	const args = ["--project", PROJECT, "--dap", "--create-data", "--headless"];
	if (EXTRA) args.push(...EXTRA.split(/\s+/));
	console.error(`4d-dap-bridge: launching ${FOURD_BIN} ${args.join(" ")}`);
	const child = spawn(FOURD_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", d => process.stderr.write(`[4D] ${d}`));
	child.stderr.on("data", d => process.stderr.write(`[4D] ${d}`));
	child.on("exit", code => console.error(`4d-dap-bridge: 4D exited (${code})`));
}

async function ensure4D(deadlineMs = 90000) {
	if (await canConnect(DAP_HOST, DAP_PORT)) return true;
	if (PROJECT) launch4D();
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		if (await canConnect(DAP_HOST, DAP_PORT)) return true;
		await new Promise(r => setTimeout(r, 300));
	}
	return false;
}

const server = net.createServer(client => {
	// Hold the client until 4D's DAP endpoint is reachable, so no DAP bytes are
	// lost while 4D is still starting up.
	client.pause();
	ensure4D()
		.then(ok => {
			if (!ok) {
				console.error(`4d-dap-bridge: 4D DAP not reachable on ${DAP_HOST}:${DAP_PORT}`);
				client.destroy();
				return;
			}
			const upstream = net.connect({ host: DAP_HOST, port: DAP_PORT }, () => {
				client.pipe(upstream);
				upstream.pipe(client);
				client.resume();
			});
			const kill = () => {
				client.destroy();
				upstream.destroy();
			};
			upstream.on("error", kill);
			client.on("error", kill);
			upstream.on("close", () => client.end());
			client.on("close", () => upstream.end());
		})
		.catch(err => {
			console.error(`4d-dap-bridge: ${err && err.message ? err.message : err}`);
			client.destroy();
		});
});

server.on("error", e => {
	console.error(`4d-dap-bridge: ${e.message}`);
	process.exit(1);
});

// omp waits for the local port number to appear on our stdout before it
// connects (see waitForTcpServerListening). Printing it here is the readiness
// signal — keep the port number in this line.
server.listen(localPort, "127.0.0.1", () => {
	console.log(`4d-dap-bridge listening on 127.0.0.1:${localPort} -> ${DAP_HOST}:${DAP_PORT}`);
});
