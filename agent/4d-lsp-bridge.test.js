"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const { discoverTool4d } = require("./4d-lsp-bridge");

function fixture(t) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "4d-discovery-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	return home;
}

function executable(file, time) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "");
	fs.utimesSync(file, time, time);
	return file;
}

test("macOS finds newest executable across Code, Insiders and nested caches", t => {
	const home = fixture(t);
	const storage = path.join(home, "Library", "Application Support");
	const cache = editor => path.join(storage, editor, "User", "globalStorage",
		"4d.4d-analyzer", "tool4d");
	executable(path.join(cache("Code"), "21", "100", "tool4d.app",
		"Contents", "MacOS", "tool4d"), 100);
	const newest = executable(path.join(cache("Code - Insiders"), "21", "200",
		"tool4d", "tool4d.app", "Contents", "MacOS", "tool4d"), 200);
	// Files and incomplete downloads must not prevent discovery.
	executable(path.join(cache("Code"), "incomplete-download"), 300);
	fs.mkdirSync(path.join(cache("Code"), "22", "300", "tool4d.app",
		"Contents", "MacOS", "tool4d"), { recursive: true });
	assert.equal(discoverTool4d({ platform: "darwin", home }), newest);
});

test("Windows uses APPDATA and Analyzer's tool4d/tool4d.exe layout", t => {
	const home = fixture(t);
	const appdata = path.join(home, "redirected roaming");
	const exe = executable(path.join(appdata, "Code", "User", "globalStorage",
		"4d.4d-analyzer", "tool4d", "21", "100", "tool4d", "tool4d.exe"), 100);
	assert.equal(discoverTool4d({
		platform: "win32", home, env: { APPDATA: appdata },
	}), exe);
});

test("Windows falls back to AppData/Roaming and supports nested Insiders caches", t => {
	const home = fixture(t);
	const exe = executable(path.join(home, "AppData", "Roaming", "Code - Insiders",
		"User", "globalStorage", "4d.4d-analyzer", "tool4d", "21", "100",
		"tool4d", "tool4d", "tool4d.exe"), 100);
	assert.equal(discoverTool4d({ platform: "win32", home, env: {} }), exe);
});

test("Linux uses Analyzer's system package executable", t => {
	t.mock.method(fs, "statSync", file => {
		assert.equal(file, "/opt/tool4d/tool4d");
		return { isFile: () => true };
	});
	assert.equal(discoverTool4d({ platform: "linux" }), "/opt/tool4d/tool4d");
});

test("missing installs return null but permission failures remain explicit", t => {
	const home = fixture(t);
	assert.equal(discoverTool4d({ platform: "darwin", home }), null);
	assert.equal(discoverTool4d({ platform: "win32", home, env: {} }), null);
	t.mock.method(fs, "statSync", () => {
		throw Object.assign(new Error("missing"), { code: "ENOENT" });
	});
	assert.equal(discoverTool4d({ platform: "linux" }), null);
	t.mock.method(fs, "statSync", () => {
		throw Object.assign(new Error("permission denied"), { code: "EACCES" });
	});
	assert.throws(() => discoverTool4d({ platform: "linux" }), /permission denied/);
});

test("launch failures report the executable path and exit unsuccessfully", t => {
	const directory = fixture(t);
	const result = spawnSync(process.execPath, [
		path.join(__dirname, "4d-lsp-bridge.js"), directory,
	], { encoding: "utf8", timeout: 5000 });
	assert.equal(result.status, 1, result.stderr);
	assert.ok(result.stderr.includes(`cannot launch ${directory}:`));
	assert.equal(result.stdout, "");
});

test("bridge relays framed LSP bytes over reverse TCP from a path with spaces", {
	skip: process.platform === "win32" ? "fixture requires a POSIX executable script" : false,
	timeout: 10000,
}, async t => {
	const tool = path.join(fixture(t), "tool with spaces");
	fs.writeFileSync(tool, `#!/usr/bin/env node
const net = require("node:net");
const port = Number(process.argv.find(arg => arg.startsWith("--lsp=")).slice(6));
const socket = net.connect(port, "127.0.0.1");
socket.on("data", data => socket.write(data));
socket.on("end", () => socket.end());
`);
	fs.chmodSync(tool, 0o755);
	const child = spawn(process.execPath, [
		path.join(__dirname, "4d-lsp-bridge.js"), tool,
	], { env: { ...process.env, TOOL4D_ARGS: "" } });
	t.after(() => child.kill());
	const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
	const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
	const received = await new Promise((resolve, reject) => {
		let output = "";
		let stderr = "";
		child.stderr.on("data", data => { stderr += data; });
		child.on("error", reject);
		child.on("exit", code => reject(new Error(`Bridge exited ${code}: ${stderr}`)));
		child.stdout.on("data", data => {
			output += data;
			if (output.length >= frame.length) resolve(output);
		});
		child.stdin.write(frame);
	});
	assert.equal(received, frame);
	child.stdin.end();
	await new Promise(resolve => child.on("exit", resolve));
});
