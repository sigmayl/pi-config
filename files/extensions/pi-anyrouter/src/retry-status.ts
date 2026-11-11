import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SqueezeRetryInfo, SqueezeRetrySettledInfo } from "./retry-fetch.ts";

/** Footer status key; one line, replaced on every retry and cleared when the sequence ends. */
export const RETRY_STATUS_KEY = "anyrouter-retry";

export interface RetryStatusReporter {
	/** Point the reporter at the current session's UI context (undefined detaches it). */
	bind(ui: ExtensionUIContext | undefined): void;
	/** A retry is about to sleep; show it instead of leaving the turn silent. */
	onRetry(info: SqueezeRetryInfo): void;
	/** The sequence ended (success, exhaustion, or abort); restore the normal working message. */
	onRetrySettled(info: SqueezeRetrySettledInfo): void;
}

export function formatRetryNotice(info: SqueezeRetryInfo): string {
	const seconds = Math.max(1, Math.round(info.delayMs / 1000));
	return `anyrouter ${info.status} · retry ${info.attempt}/${info.maxRetries} · ${seconds}s`;
}

/**
 * Pi's built-in retry indicator only covers agent-level retries. The squeeze loop
 * lives inside the provider's `fetch`, so Pi never sees those attempts and the
 * working line would just sit there. This reporter reuses the same channels Pi
 * uses for its own indicators:
 *
 * - `setWorkingMessage` replaces the spinner text while the turn is streaming (TUI).
 * - `setStatus` adds a footer line that also survives into RPC mode.
 *
 * Both are restored as soon as the retry sequence settles, so a successful retry
 * leaves no residue.
 */
export function createRetryStatusReporter(enabled: boolean): RetryStatusReporter {
	let ui: ExtensionUIContext | undefined;
	let workingMessageSet = false;
	let footerSet = false;
	// Concurrent sequences (e.g. a cache-warming request next to the main one) each
	// settle independently; only the last one may clear the shared UI.
	let pendingSequences = 0;

	const clear = () => {
		if (!ui) return;
		if (workingMessageSet) {
			ui.setWorkingMessage(undefined);
			workingMessageSet = false;
		}
		if (footerSet) {
			ui.setStatus(RETRY_STATUS_KEY, undefined);
			footerSet = false;
		}
	};

	return {
		bind(next) {
			if (next === ui) return;
			clear();
			pendingSequences = 0;
			ui = next;
		},
		onRetry(info) {
			if (!enabled || !ui) return;
			if (info.attempt === 1) pendingSequences++;
			const notice = formatRetryNotice(info);
			ui.setWorkingMessage(`${notice} (esc to interrupt)`);
			workingMessageSet = true;
			ui.setStatus(RETRY_STATUS_KEY, notice);
			footerSet = true;
		},
		onRetrySettled(_info: SqueezeRetrySettledInfo) {
			if (pendingSequences > 0) pendingSequences--;
			if (pendingSequences === 0) clear();
		},
	};
}
