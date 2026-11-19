import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CacheKeyStore } from "../src/cache-key.ts";

async function withStore(
	run: (store: CacheKeyStore, file: string) => Promise<void>,
	options: { now?: () => number; generate?: () => string } = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "anyrouter-cache-key-"));
	const file = join(dir, "keys.json");
	try {
		await run(new CacheKeyStore({ file, ...options }), file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("creates and persists one key per session", async () => {
	await withStore(async (store, file) => {
		const state = await store.activate("session-a");
		assert.ok(state);
		assert.match(state.key, /^[0-9a-f-]{36}$/);
		assert.equal(store.keyForSession("session-a"), state.key);

		const persisted = JSON.parse(await readFile(file, "utf8")) as {
			version: number;
			sessions: Record<string, { key: string }>;
		};
		assert.equal(persisted.version, 1);
		assert.equal(persisted.sessions["session-a"]?.key, state.key);
	});
});

test("reuses a persisted key after reload", async () => {
	await withStore(async (store, file) => {
		const first = await store.activate("session-a");
		assert.ok(first);

		const reloaded = new CacheKeyStore({ file });
		const second = await reloaded.activate("session-a");
		assert.equal(second?.key, first.key);
	});
});

test("rotates the key and keeps other sessions untouched", async () => {
	let generated = 0;
	await withStore(
		async (store) => {
			const a = await store.activate("session-a");
			const b = await store.activate("session-b");
			assert.ok(a && b);
			assert.notEqual(a.key, b.key);

			const rotated = await store.rotate("session-a");
			assert.notEqual(rotated.key, a.key);
			assert.equal(rotated.updatedAt, 1000);
			assert.equal(store.keyForSession("session-a"), rotated.key);
			assert.equal(store.keyForSession("session-b"), b.key);
		},
		{ now: () => 1000, generate: () => `key-${++generated}` },
	);
});

test("accepts an explicit key and resets back to Pi's session id", async () => {
	await withStore(async (store, file) => {
		await store.activate("session-a");
		const state = await store.rotate("session-a", "  my-cache-key  ");
		assert.equal(state.key, "my-cache-key");
		assert.equal(store.keyForSession("session-a"), "my-cache-key");

		await store.reset("session-a");
		assert.equal(store.keyForSession("session-a"), undefined);
		assert.equal(store.state("session-a"), undefined);
		// Reactivating a reset session must not silently create a new key.
		assert.equal(await store.activate("session-a"), undefined);

		const reloaded = new CacheKeyStore({ file });
		assert.equal(await reloaded.activate("session-a"), undefined);
	});
});

test("falls back to the active key only for one-off requests", async () => {
	await withStore(async (store) => {
		const active = await store.activate("session-a");
		assert.ok(active);

		// Compaction gets a fresh session id from Pi; reuse the active key.
		assert.equal(store.activeKey(), active.key);
		// A normal request from an unknown session must not borrow it.
		assert.equal(store.keyForSession("other-session"), undefined);
	});
});

test("ignores a corrupt state file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "anyrouter-cache-key-"));
	const file = join(dir, "keys.json");
	try {
		await writeFile(file, "{not json");
		const store = new CacheKeyStore({ file });
		const state = await store.activate("session-a");
		assert.ok(state?.key);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
