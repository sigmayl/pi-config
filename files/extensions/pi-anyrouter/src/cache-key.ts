import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * AnyRouter routes and caches requests by session id / `prompt_cache_key`.
 * Keeping the value stable across restarts preserves the relay's cache and
 * channel affinity; rotating it starts a fresh cache namespace.
 */
export interface CacheKeyState {
	/** Value sent as the provider `sessionId` (and therefore `prompt_cache_key`). */
	key: string;
	/** Epoch milliseconds of the last rotation. */
	updatedAt: number;
}

interface CacheKeyFile {
	version: 1;
	sessions: Record<string, CacheKeyState>;
	/** Session ids that opted out of the override (via `reset`). */
	disabled?: string[];
}

export interface CacheKeyStoreOptions {
	/** JSON file that persists one key per Pi session id. */
	file: string;
	now?: () => number;
	generate?: () => string;
}

/** Default persistence file: `~/.pi/agent/anyrouter-cache-keys.json`. */
export function defaultCacheKeyFile(): string {
	return join(getAgentDir(), "anyrouter-cache-keys.json");
}

function isCacheKeyState(value: unknown): value is CacheKeyState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<CacheKeyState>;
	return typeof state.key === "string" && state.key.trim().length > 0 && typeof state.updatedAt === "number";
}

/**
 * Per-session prompt-cache key store.
 *
 * The store keeps an in-memory view for synchronous stream-option preparation
 * and writes the whole map to disk after each change. Writes are serialized so
 * concurrent rotations cannot interleave.
 */
export class CacheKeyStore {
	private readonly file: string;
	private readonly now: () => number;
	private readonly generate: () => string;
	private readonly sessions = new Map<string, CacheKeyState>();
	private readonly disabled = new Set<string>();
	private activeSessionId: string | undefined;
	private loadPromise: Promise<void> | undefined;
	private saveChain: Promise<void> = Promise.resolve();

	constructor(options: CacheKeyStoreOptions) {
		this.file = options.file;
		this.now = options.now ?? Date.now;
		this.generate = options.generate ?? randomUUID;
	}

	/** Load persisted keys from disk. Safe to call repeatedly. */
	load(): Promise<void> {
		this.loadPromise ??= this.read();
		return this.loadPromise;
	}

	private async read(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.file, "utf8");
		} catch (error) {
			// A missing file is the normal first-run case.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<CacheKeyFile>;
			for (const [sessionId, state] of Object.entries(parsed.sessions ?? {})) {
				if (isCacheKeyState(state)) this.sessions.set(sessionId, state);
			}
			for (const sessionId of parsed.disabled ?? []) {
				if (typeof sessionId === "string" && sessionId) this.disabled.add(sessionId);
			}
		} catch {
			// A corrupt state file must not break the provider; start fresh.
		}
	}

	/** Make `sessionId` active and return its persisted key, creating one if needed. */
	async activate(sessionId: string | undefined): Promise<CacheKeyState | undefined> {
		await this.load();
		this.activeSessionId = sessionId;
		if (!sessionId || this.disabled.has(sessionId)) return undefined;
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const state = { key: this.generate(), updatedAt: this.now() };
		this.sessions.set(sessionId, state);
		await this.persist();
		return state;
	}

	/**
	 * Key for a known Pi session id. Returns undefined for one-off requests that
	 * Pi gives a fresh id (compaction and branch summaries).
	 */
	keyForSession(sessionId: string | undefined): string | undefined {
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId)?.key;
	}

	/** Key of the active session, used for one-off summary requests. */
	activeKey(): string | undefined {
		return this.activeSessionId ? this.sessions.get(this.activeSessionId)?.key : undefined;
	}

	/** Current state for `sessionId`, or for the active session when omitted. */
	state(sessionId?: string): CacheKeyState | undefined {
		const target = sessionId ?? this.activeSessionId;
		return target ? this.sessions.get(target) : undefined;
	}

	/** Replace the key for `sessionId` (or the active session) and persist it. */
	async rotate(sessionId: string | undefined, key?: string): Promise<CacheKeyState> {
		await this.load();
		const target = sessionId ?? this.activeSessionId;
		if (!target) throw new Error("No active session to rotate the AnyRouter cache key for.");
		const state = { key: key?.trim() || this.generate(), updatedAt: this.now() };
		this.sessions.set(target, state);
		this.disabled.delete(target);
		this.activeSessionId = target;
		await this.persist();
		return state;
	}

	/** Drop the override so Pi's own session id is used again. */
	async reset(sessionId: string | undefined): Promise<void> {
		await this.load();
		const target = sessionId ?? this.activeSessionId;
		if (!target) return;
		this.sessions.delete(target);
		this.disabled.add(target);
		await this.persist();
	}

	private persist(): Promise<void> {
		const payload: CacheKeyFile = {
			version: 1,
			sessions: Object.fromEntries(this.sessions),
			...(this.disabled.size > 0 ? { disabled: [...this.disabled] } : {}),
		};
		// Keep the chain alive after a failed write so later rotations still save.
		const write = this.saveChain.catch(() => {}).then(() => this.write(payload));
		this.saveChain = write.catch(() => {});
		return write;
	}

	private async write(payload: CacheKeyFile): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const temp = `${this.file}.${process.pid}.tmp`;
		await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, this.file);
	}
}
