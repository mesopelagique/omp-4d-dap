"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

function directory(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "4d-install-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function install(args, env = {}) {
	return spawnSync(process.execPath, [path.join(__dirname, "install.js"), ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

test("Copilot installation merges configuration and is repeatable", t => {
	const dir = directory(t);
	const configPath = path.join(dir, "lsp-config.json");
	const existing = {
		lspServers: {
			typescript: { command: "typescript-language-server", args: ["--stdio"] },
			"4d": { env: { TOOL4D_BIN: "/custom/tool4d" } },
		},
	};
	fs.writeFileSync(configPath, JSON.stringify(existing));
	for (let i = 0; i < 2; i++) {
		const result = install(["--copilot", "--dir", dir]);
		assert.equal(result.status, 0, result.stderr);
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		assert.deepEqual(config.lspServers.typescript, existing.lspServers.typescript);
		assert.deepEqual(config.lspServers["4d"], {
			env: { TOOL4D_BIN: "/custom/tool4d" },
			command: process.execPath,
			args: [path.join(dir, "4d-lsp-bridge.js")],
			fileExtensions: { ".4dm": "4d", ".4qs": "4qs" },
		});
	}
	assert.equal(fs.readFileSync(path.join(dir, "4d-lsp-bridge.js"), "utf8"),
		fs.readFileSync(path.join(__dirname, "agent/4d-lsp-bridge.js"), "utf8"));
	assert.equal(fs.existsSync(path.join(dir, "dap.json")), false);
});

test("Copilot honors COPILOT_HOME rather than OMP_AGENT_DIR", t => {
	const dir = directory(t);
	const result = install(["--copilot"], {
		COPILOT_HOME: dir,
		OMP_AGENT_DIR: path.join(dir, "omp"),
	});
	assert.equal(result.status, 0, result.stderr);
	assert.ok(fs.existsSync(path.join(dir, "lsp-config.json")));
	assert.equal(fs.existsSync(path.join(dir, "omp")), false);
});

test("Copilot rejects malformed configuration without overwriting it", t => {
	const dir = directory(t);
	const configPath = path.join(dir, "lsp-config.json");
	for (const content of ["{", "null", '{"lspServers":[]}']) {
		fs.writeFileSync(configPath, content);
		const result = install(["--copilot", "--dir", dir]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Error/);
		assert.equal(fs.readFileSync(configPath, "utf8"), content);
	}
});

test("default installation still writes omp adapters", t => {
	const dir = directory(t);
	const result = install(["--dir", dir]);
	assert.equal(result.status, 0, result.stderr);
	const lsp = JSON.parse(fs.readFileSync(path.join(dir, "lsp.json"), "utf8"));
	const dap = JSON.parse(fs.readFileSync(path.join(dir, "dap.json"), "utf8"));
	assert.deepEqual(lsp.servers["4d"].args, [path.join(dir, "4d-lsp-bridge.js")]);
	assert.deepEqual(dap.adapters["4d"].args,
		[path.join(dir, "4d-dap-bridge.js"), "${port}"]);
	assert.equal(fs.existsSync(path.join(dir, "lsp-config.json")), false);
});
