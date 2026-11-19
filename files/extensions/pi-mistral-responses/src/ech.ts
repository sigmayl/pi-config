import { createRequire } from "node:module";
import { isIP, type Socket } from "node:net";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { Agent, buildConnector } from "undici";
import { DEFAULT_BASE_URL, type EchMode } from "./config.ts";

const mistral = new URL(DEFAULT_BASE_URL);
const cloudflareEchHost = "crypto.cloudflare.com";
const publicDoh = [
	{ url: "https://cloudflare-dns.com/dns-query", ips: ["1.1.1.1", "1.0.0.1"] },
	{ url: "https://dns.google/resolve", ips: ["8.8.8.8", "8.8.4.4"] },
];
const echBootstrapDoh = [
	{ url: "https://dns.alidns.com/resolve", ips: ["223.5.5.5", "223.6.6.6"] },
	...publicDoh,
];
const mistralDoh = [
	{ url: "https://mozilla.cloudflare-dns.com/dns-query", ips: ["172.64.41.4", "162.159.61.4"], ech: true },
	...publicDoh,
];
const dnsTimeoutMs = 4_000;
const handshakeTimeoutMs = 5_000;

interface EchRecord {
	config: string;
	expiresAt: number;
}

interface MistralEndpoint extends EchRecord {
	ips: string[];
}

interface DohResolver {
	url: string;
	ips: string[];
	ech?: boolean;
}

interface DnsRecord {
	type: number;
	data: string;
	TTL?: number;
}

type DnsQuery = (name: string, type: "A" | "AAAA" | "HTTPS") => Promise<DnsRecord[]>;

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

function dnsExpiry(records: DnsRecord[]): number {
	const ttl = Math.min(600, ...records.map(({ TTL = 0 }) => Number.isFinite(TTL) ? Math.max(0, TTL) : 0));
	return Date.now() + ttl * 1_000;
}

async function queryResolvers<T>(
	resolvers: DohResolver[],
	signal: AbortSignal,
	read: (query: DnsQuery) => Promise<T>,
	failure: string,
	ech?: string,
): Promise<T> {
	const race = new AbortController();
	const raceSignal = AbortSignal.any([signal, race.signal]);
	async function queryResolver(resolver: DohResolver, ip: string): Promise<T> {
		const url = new URL(resolver.url);
		const requestSignal = AbortSignal.any([raceSignal, AbortSignal.timeout(dnsTimeoutMs)]);
		const connect = buildConnector({ timeout: dnsTimeoutMs, rejectUnauthorized: true });
		const dispatcher = new Agent({
			allowH2: true,
			connect: (options: buildConnector.Options, callback: buildConnector.Callback) => {
				if (resolver.ech && ech) {
					void connectEch(url.hostname, ip, ech, requestSignal).then(
						(socket) => callback(null, socket),
						(error: Error) => callback(error, null),
					);
					return;
				}
				connect({ ...options, hostname: ip, servername: url.hostname }, callback);
			},
		});
		try {
			return await read(async (name, type) => {
				const request = new URL(url);
				request.searchParams.set("name", name);
				request.searchParams.set("type", type === "HTTPS" ? "65" : type);
				const options = {
					dispatcher,
					headers: { accept: "application/dns-json" },
					redirect: "error" as const,
					signal: requestSignal,
				};
				const response = await fetch(request, options);
				if (!response.ok) throw new Error(`${url.hostname} returned HTTP ${response.status}`);
				const payload = (await response.json()) as { Status?: number; Answer?: DnsRecord[] };
				if (payload.Status !== 0) throw new Error(`${url.hostname} returned DNS status ${payload.Status}`);
				return Array.isArray(payload.Answer) ? payload.Answer : [];
			});
		} finally {
			await dispatcher.destroy();
		}
	}

	try {
		return await Promise.any(resolvers.flatMap((resolver) => resolver.ips.map((ip) => queryResolver(resolver, ip))));
	} catch (error) {
		signal.throwIfAborted();
		throw new Error(failure, { cause: error });
	} finally {
		race.abort();
	}
}

async function resolveMistral(signal: AbortSignal): Promise<MistralEndpoint> {
	const ech = await queryResolvers(echBootstrapDoh, signal, async (query) => {
		for (const record of await query(cloudflareEchHost, "HTTPS")) {
			if (record.type !== 65 || typeof record.data !== "string") continue;
			const config = /(?:^|\s)ech="?([A-Za-z0-9+/]+={0,2})"?(?:\s|$)/.exec(record.data)?.[1];
			if (!config) continue;
			return { config, expiresAt: dnsExpiry([record]) };
		}
		throw new Error("Cloudflare HTTPS record did not contain an ECH configuration");
	}, "Could not retrieve Cloudflare ECH configuration");

	return queryResolvers(mistralDoh, signal, async (query) => {
		const answers = await Promise.allSettled([query(mistral.hostname, "A"), query(mistral.hostname, "AAAA")]);
		const records = answers.flatMap((answer) => answer.status === "fulfilled" ? answer.value : []);
		const addresses = records.filter((record) =>
			typeof record.data === "string" && (
				(record.type === 1 && isIP(record.data) === 4) ||
				(record.type === 28 && isIP(record.data) === 6)
			),
		);
		if (!addresses.length) throw new Error("DoH returned no usable Mistral addresses");
		const ips = [...new Set(addresses.map(({ data }) => data))];
		const expiresAt = dnsExpiry([...addresses, ...records.filter((record) => record.type === 5)]);
		return { config: ech.config, ips, expiresAt: Math.min(ech.expiresAt, expiresAt) };
	}, "Could not resolve api.mistral.ai through Cloudflare or Google DoH", ech.config);
}

async function connectEch(hostname: string, ip: string, ech: string, signal: AbortSignal): Promise<Socket> {
	const { connect } = await import("lemon-tls");
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const socket = connect({
			host: ip,
			port: 443,
			servername: hostname,
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
				fail(new Error(`TLS did not authenticate and accept ECH for ${hostname}`));
				return;
			}
			cleanup();
			// Undici's connector type names Node's socket. lemon-tls supplies the socket methods it uses.
			resolve(socket as unknown as Socket);
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
	let cached: MistralEndpoint | undefined;
	let pending: Promise<MistralEndpoint> | undefined;

	function endpointForConnection(): Promise<MistralEndpoint> {
		if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
		pending ??= resolveMistral(signal)
			.then((record) => (cached = record))
			.finally(() => {
				pending = undefined;
			});
		return pending;
	}

	async function connectMistral(): Promise<Socket> {
		const endpoint = await endpointForConnection();
		const errors: unknown[] = [];
		for (const ip of endpoint.ips) {
			signal.throwIfAborted();
			try {
				return await connectEch(mistral.hostname, ip, endpoint.config, signal);
			} catch (error) {
				errors.push(error);
			}
		}
		if (cached === endpoint) cached = undefined;
		throw new AggregateError(errors, "ECH failed on the Mistral addresses returned by DoH");
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
