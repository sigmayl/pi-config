import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { FetchFunction } from "@earendil-works/pi-ai";
import type { TLSSocket } from "lemon-tls";
import { Agent, buildConnector } from "undici";
import { DEFAULT_BASE_URL, type EchMode } from "./config.ts";

const mistral = new URL(DEFAULT_BASE_URL);
const mistralEdgeIps = ["172.66.2.203", "162.159.142.207"];
const dohUrl = "https://dns.alidns.com/resolve?name=crypto.cloudflare.com&type=65";
const dohIps = ["223.5.5.5", "223.6.6.6"];
const dnsTimeoutMs = 4_000;
const handshakeTimeoutMs = 5_000;

interface EchRecord {
	config: string;
	expiresAt: number;
}

interface DnsResponse {
	Answer?: { type?: number; data?: string; TTL?: number }[];
}

function echAvailable(mode: EchMode): boolean {
	if (mode === "0") return false;
	if (Number(process.versions.node.split(".")[0]) >= 24) {
		try {
			createRequire(import.meta.url).resolve("lemon-tls");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
		}
	}
	if (mode === "1") throw new Error("Mistral ECH requires Node.js 24 or newer and the lemon-tls package");
	return false;
}

async function queryCloudflareEch(ip: string, signal: AbortSignal): Promise<EchRecord> {
	const connect = buildConnector({ timeout: dnsTimeoutMs, rejectUnauthorized: true });
	const dispatcher = new Agent({
		connect: (options: buildConnector.Options, callback: buildConnector.Callback) =>
			connect({ ...options, hostname: ip, servername: "dns.alidns.com" }, callback),
	});
	try {
		const options = {
			dispatcher,
			headers: { accept: "application/dns-json" },
			redirect: "error" as const,
			signal: AbortSignal.any([signal, AbortSignal.timeout(dnsTimeoutMs)]),
		};
		const response = await fetch(dohUrl, options);
		if (!response.ok) throw new Error(`DoH returned HTTP ${response.status}`);
		const payload = (await response.json()) as DnsResponse;
		for (const record of payload.Answer ?? []) {
			if (record.type !== 65 || typeof record.data !== "string") continue;
			const config = /(?:^|\s)ech="?([A-Za-z0-9+/]+={0,2})"?(?:\s|$)/.exec(record.data)?.[1];
			if (!config) continue;
			const ttl = typeof record.TTL === "number" && Number.isFinite(record.TTL) ? record.TTL : 0;
			return { config, expiresAt: Date.now() + Math.min(Math.max(0, ttl), 600) * 1_000 };
		}
		throw new Error("Cloudflare HTTPS record did not contain an ECH configuration");
	} finally {
		await dispatcher.destroy();
	}
}

async function connectEdge(ip: string, ech: string, signal: AbortSignal): Promise<TLSSocket> {
	const { connect } = await import("lemon-tls");
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const socket = connect({
			host: ip,
			port: 443,
			servername: mistral.hostname,
			ech,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
			ALPNProtocols: ["h2", "http/1.1"],
			rejectUnauthorized: true,
		});
		const timeout = setTimeout(() => fail(new Error(`TLS handshake timed out for ${ip}`)), handshakeTimeoutMs);
		const onClose = () => fail(new Error(`TLS connection to ${ip} closed during handshake`));
		const onAbort = () => fail(signal.reason);
		const onSecure = () => {
			if (!socket.authorized || socket.echStatus !== "accepted") {
				fail(new Error(`TLS did not authenticate and accept ECH for ${mistral.hostname}`));
				return;
			}
			cleanup();
			resolve(socket);
		};
		function cleanup(): void {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			socket.removeListener("error", fail);
			socket.removeListener("close", onClose);
			socket.removeListener("secureConnect", onSecure);
		}
		function fail(error: Error): void {
			cleanup();
			socket.destroy();
			reject(error);
		}
		socket.once("error", fail);
		socket.once("close", onClose);
		socket.once("secureConnect", onSecure);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function createEchTransport(mode: EchMode) {
	if (!echAvailable(mode)) return undefined;

	const lifetime = new AbortController();
	const signal = lifetime.signal;
	let cached: EchRecord | undefined;
	let pending: Promise<EchRecord> | undefined;

	function configForConnection(): Promise<EchRecord> {
		if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
		pending ??= Promise.any(dohIps.map((ip) => queryCloudflareEch(ip, signal)))
			.then((record) => (cached = record))
			.finally(() => {
				pending = undefined;
			});
		return pending;
	}

	async function connectMistral(): Promise<Socket> {
		const record = await configForConnection();
		const errors: unknown[] = [];
		for (const ip of mistralEdgeIps) {
			signal.throwIfAborted();
			try {
				const socket = await connectEdge(ip, record.config, signal);
				// Undici's type names Node's socket, while its connector accepts this TLS Duplex.
				return socket as unknown as Socket;
			} catch (error) {
				errors.push(error);
			}
		}
		if (cached === record) cached = undefined;
		throw new AggregateError(errors, "ECH failed on both Mistral edge addresses");
	}

	const dispatcher = new Agent({
		allowH2: true,
		connect: ({ hostname, protocol, port }: buildConnector.Options, callback: buildConnector.Callback) => {
			if (hostname !== mistral.hostname || protocol !== mistral.protocol || (port && port !== "443")) {
				callback(new Error("ECH transport is restricted to api.mistral.ai:443"), null);
				return;
			}
			void connectMistral().then(
				(socket) => callback(null, socket),
				(error: Error) => callback(error, null),
			);
		},
	});
	return {
		wrapFetch(baseFetch: FetchFunction = globalThis.fetch): FetchFunction {
			return (input, init) => {
				const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
				if (url.origin !== mistral.origin) return baseFetch(input, init);
				const options = { ...init, dispatcher };
				return baseFetch(input, options);
			};
		},
		async close(): Promise<void> {
			lifetime.abort();
			await dispatcher.destroy();
		},
	};
}
