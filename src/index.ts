import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const CUSTOM_TYPE = "pi-feedback";
const FEEDBACK_FILE = "FEEDBACK.md";
const STORE_START = "<!-- pi-feedback:start -->";
const STORE_END = "<!-- pi-feedback:end -->";
const STORE_VERSION = 1;
const MAX_TRANSCRIPT_CHARS = 70_000;
const MAX_FIELD_CHARS = 700;
const MAX_REASON_COUNT = 8;
const MAX_PATTERN_COUNT = 24;
const MAX_EVIDENCE_SAMPLES = 3;

const RATINGS = ["terrible", "bad", "good", "great", "perfect"] as const;
type FeedbackRating = (typeof RATINGS)[number];
type PatternKind = "positive" | "negative";
type AgentCandidateKind = "encourage" | "avoid";

type JsonRecord = Record<string, unknown>;

interface FeedbackSettings {
	nudges: boolean;
	memory_followups: boolean;
	agents_followups: boolean;
	repeated_pattern_threshold: number;
	max_entries: number;
}

interface PatternSummary {
	id: string;
	kind: PatternKind;
	text: string;
	count: number;
	first_seen: string;
	last_seen: string;
	agents_candidate: boolean;
	evidence_samples: string[];
}

interface FeedbackEntry {
	id: string;
	at: string;
	rating: FeedbackRating;
	note?: string;
	status: "pending" | "analyzed" | "analysis_failed";
	session_file?: string;
	session_entries: number;
	analysis_summary: string;
	reasons: string[];
	root_causes: string[];
	memory_suggestions: string[];
	agents_candidates: string[];
	patterns: string[];
	analysis_error?: string;
}

interface FeedbackStore {
	version: 1;
	updated_at: string;
	settings: FeedbackSettings;
	patterns: PatternSummary[];
	entries: FeedbackEntry[];
}

interface AnalysisPattern {
	kind: PatternKind;
	text: string;
	evidence: string;
}

interface AgentsCandidate {
	kind: AgentCandidateKind;
	text: string;
	evidence: string;
}

interface FeedbackAnalysis {
	summary: string;
	reasons: string[];
	root_causes: string[];
	good_behaviors: string[];
	bad_behaviors: string[];
	repeated_patterns: AnalysisPattern[];
	memory_suggestions: string[];
	agents_candidates: AgentsCandidate[];
}

interface FeedbackSnapshot {
	entryId: string;
	rating: FeedbackRating;
	note?: string;
	cwd: string;
	sessionFile?: string;
	sessionEntries: number;
	transcript: string;
	knownPatterns: PatternSummary[];
}

const DEFAULT_SETTINGS: FeedbackSettings = {
	nudges: true,
	memory_followups: false,
	agents_followups: false,
	repeated_pattern_threshold: 3,
	max_entries: 20,
};

let feedbackFileQueue: Promise<unknown> = Promise.resolve();

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isFeedbackRating = (value: string): value is FeedbackRating =>
	(RATINGS as readonly string[]).includes(value);

const truncate = (value: string, max = MAX_FIELD_CHARS): string => {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const uniqueStrings = (values: string[], max = MAX_REASON_COUNT): string[] => {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const clean = truncate(value);
		if (!clean) continue;
		const key = clean.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(clean);
		if (result.length >= max) break;
	}
	return result;
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(max, Math.max(min, Math.round(numeric)));
};

const normalizeSettings = (settings: unknown): FeedbackSettings => {
	const source = isRecord(settings) ? settings : {};
	return {
		nudges: typeof source.nudges === "boolean" ? source.nudges : DEFAULT_SETTINGS.nudges,
		memory_followups:
			typeof source.memory_followups === "boolean"
				? source.memory_followups
				: DEFAULT_SETTINGS.memory_followups,
		agents_followups:
			typeof source.agents_followups === "boolean"
				? source.agents_followups
				: DEFAULT_SETTINGS.agents_followups,
		repeated_pattern_threshold: clampInteger(
			source.repeated_pattern_threshold,
			DEFAULT_SETTINGS.repeated_pattern_threshold,
			2,
			10,
		),
		max_entries: clampInteger(source.max_entries, DEFAULT_SETTINGS.max_entries, 5, 50),
	};
};

const normalizeKind = (kind: unknown, fallback: PatternKind = "negative"): PatternKind =>
	kind === "positive" || kind === "negative" ? kind : fallback;

const normalizeCandidateKind = (kind: unknown): AgentCandidateKind =>
	kind === "encourage" || kind === "avoid" ? kind : "avoid";

const normalizePattern = (value: unknown): PatternSummary | undefined => {
	if (!isRecord(value)) return undefined;
	const text = truncate(String(value.text ?? ""));
	if (!text) return undefined;
	const id = String(value.id ?? patternId(normalizeKind(value.kind), text));
	return {
		id,
		kind: normalizeKind(value.kind),
		text,
		count: clampInteger(value.count, 1, 1, 999),
		first_seen: typeof value.first_seen === "string" ? value.first_seen : new Date().toISOString(),
		last_seen: typeof value.last_seen === "string" ? value.last_seen : new Date().toISOString(),
		agents_candidate: typeof value.agents_candidate === "boolean" ? value.agents_candidate : false,
		evidence_samples: Array.isArray(value.evidence_samples)
			? uniqueStrings(value.evidence_samples.map(String), MAX_EVIDENCE_SAMPLES)
			: [],
	};
};

const normalizeEntry = (value: unknown): FeedbackEntry | undefined => {
	if (!isRecord(value)) return undefined;
	const rating = typeof value.rating === "string" && isFeedbackRating(value.rating) ? value.rating : undefined;
	if (!rating) return undefined;
	const id = typeof value.id === "string" ? value.id : makeEntryId();
	const status =
		value.status === "pending" || value.status === "analyzed" || value.status === "analysis_failed"
			? value.status
			: "analyzed";
	return {
		id,
		at: typeof value.at === "string" ? value.at : new Date().toISOString(),
		rating,
		note: typeof value.note === "string" && value.note.trim() ? truncate(value.note) : undefined,
		status,
		session_file: typeof value.session_file === "string" ? value.session_file : undefined,
		session_entries: clampInteger(value.session_entries, 0, 0, 100_000),
		analysis_summary: truncate(String(value.analysis_summary ?? "")),
		reasons: Array.isArray(value.reasons) ? uniqueStrings(value.reasons.map(String)) : [],
		root_causes: Array.isArray(value.root_causes) ? uniqueStrings(value.root_causes.map(String)) : [],
		memory_suggestions: Array.isArray(value.memory_suggestions)
			? uniqueStrings(value.memory_suggestions.map(String))
			: [],
		agents_candidates: Array.isArray(value.agents_candidates)
			? uniqueStrings(value.agents_candidates.map(String))
			: [],
		patterns: Array.isArray(value.patterns) ? uniqueStrings(value.patterns.map(String), MAX_PATTERN_COUNT) : [],
		analysis_error: typeof value.analysis_error === "string" ? truncate(value.analysis_error) : undefined,
	};
};

const defaultStore = (): FeedbackStore => ({
	version: STORE_VERSION,
	updated_at: new Date().toISOString(),
	settings: { ...DEFAULT_SETTINGS },
	patterns: [],
	entries: [],
});

const normalizeStore = (value: unknown): FeedbackStore => {
	if (!isRecord(value)) return defaultStore();
	const settings = normalizeSettings(value.settings);
	const entries = Array.isArray(value.entries)
		? value.entries.map(normalizeEntry).filter((entry): entry is FeedbackEntry => Boolean(entry))
		: [];
	const patterns = Array.isArray(value.patterns)
		? value.patterns.map(normalizePattern).filter((pattern): pattern is PatternSummary => Boolean(pattern))
		: [];
	return {
		version: STORE_VERSION,
		updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date().toISOString(),
		settings,
		patterns: patterns.slice(0, MAX_PATTERN_COUNT),
		entries: entries.slice(0, settings.max_entries),
	};
};

const feedbackPath = (cwd: string): string => join(cwd, FEEDBACK_FILE);

const extractStoreJson = (raw: string): string | undefined => {
	const start = raw.indexOf(STORE_START);
	const end = raw.indexOf(STORE_END);
	if (start < 0 || end < 0 || end <= start) return undefined;
	const block = raw.slice(start + STORE_START.length, end).trim();
	const fenced = block.match(/```json\s*([\s\S]*?)\s*```/i);
	return (fenced?.[1] ?? block).trim();
};

const readFeedbackStore = async (cwd: string): Promise<FeedbackStore> => {
	try {
		const raw = await readFile(feedbackPath(cwd), "utf8");
		const json = extractStoreJson(raw);
		if (!json) return defaultStore();
		return normalizeStore(JSON.parse(json));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return defaultStore();
		throw error;
	}
};

const renderStoreBlock = (store: FeedbackStore): string =>
	[
		STORE_START,
		"```json",
		JSON.stringify(store, null, 2),
		"```",
		STORE_END,
		"",
	].join("\n");

const writeFeedbackStore = async (cwd: string, store: FeedbackStore): Promise<void> => {
	store.updated_at = new Date().toISOString();
	store.settings = normalizeSettings(store.settings);
	store.entries = store.entries.slice(0, store.settings.max_entries);
	store.patterns = store.patterns.slice(0, MAX_PATTERN_COUNT);

	const path = feedbackPath(cwd);
	await mkdir(dirname(path), { recursive: true });

	let raw = "";
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}

	const block = renderStoreBlock(store);
	const start = raw.indexOf(STORE_START);
	const end = raw.indexOf(STORE_END);
	const next =
		start >= 0 && end > start
			? `${raw.slice(0, start)}${block}${raw.slice(end + STORE_END.length).replace(/^\n+/, "")}`
			: raw.trim()
				? `${raw.trimEnd()}\n\n## pi-feedback data\n\n${block}`
				: `# Feedback\n\nShort structured feedback log maintained by pi-feedback.\n\n${block}`;

	await writeFile(path, next, "utf8");
};

const updateFeedbackStore = async <T>(
	cwd: string,
	updater: (store: FeedbackStore) => Promise<{ store: FeedbackStore; result: T }> | { store: FeedbackStore; result: T },
): Promise<T> => {
	const run = feedbackFileQueue.then(async () => {
		const store = await readFeedbackStore(cwd);
		const updated = await updater(store);
		await writeFeedbackStore(cwd, normalizeStore(updated.store));
		return updated.result;
	});
	feedbackFileQueue = run.catch(() => undefined);
	return run;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
	isRecord(error) && typeof error.code === "string";

const makeEntryId = (): string => `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const stableHash = (input: string): string => {
	let hash = 5381;
	for (let index = 0; index < input.length; index += 1) {
		hash = (hash * 33) ^ input.charCodeAt(index);
	}
	return (hash >>> 0).toString(36);
};

const patternId = (kind: PatternKind, text: string): string => {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return `${kind}-${stableHash(normalized)}`;
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts;
};

const extractToolCalls = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];
	const calls: string[] = [];
	for (const part of content) {
		if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
		const toolCall = part as unknown as ToolCall;
		calls.push(`Tool call: ${toolCall.name} ${truncate(JSON.stringify(toolCall.arguments ?? {}), 500)}`);
	}
	return calls;
};

const formatMessageEntry = (entry: JsonRecord): string[] => {
	const message = isRecord(entry.message) ? entry.message : undefined;
	if (!message || typeof message.role !== "string") return [];

	const role = message.role;
	const lines: string[] = [];
	const text = extractTextParts(message.content).join("\n").trim();

	if (role === "user" || role === "assistant") {
		if (text) lines.push(`${role.toUpperCase()}: ${truncate(text, 2_000)}`);
		if (role === "assistant") lines.push(...extractToolCalls(message.content));
		return lines;
	}

	if (role === "toolResult") {
		const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
		if (text) lines.push(`TOOL RESULT ${toolName}: ${truncate(text, 900)}`);
		return lines;
	}

	if (role === "custom") {
		const customType = typeof message.customType === "string" ? message.customType : "custom";
		if (text) lines.push(`CUSTOM ${customType}: ${truncate(text, 900)}`);
	}

	return lines;
};

const buildSessionTranscript = (entries: readonly unknown[]): string => {
	const sections: string[] = [];
	for (const value of entries) {
		if (!isRecord(value) || typeof value.type !== "string") continue;
		if (value.type === "message") {
			sections.push(...formatMessageEntry(value));
			continue;
		}
		if (value.type === "compaction" && typeof value.summary === "string") {
			sections.push(`COMPACTION SUMMARY: ${truncate(value.summary, 1_500)}`);
			continue;
		}
		if (value.type === "branch_summary" && typeof value.summary === "string") {
			sections.push(`BRANCH SUMMARY: ${truncate(value.summary, 1_500)}`);
		}
	}

	const transcript = sections.join("\n\n");
	if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
	const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
	return [
		transcript.slice(0, half),
		`\n\n[pi-feedback omitted ${transcript.length - MAX_TRANSCRIPT_CHARS} middle characters for model context safety]\n\n`,
		transcript.slice(-half),
	].join("");
};

const textFromAssistant = (message: AssistantMessage): string =>
	message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n");

const parseJsonObject = (text: string): unknown => {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenced?.[1]) return JSON.parse(fenced[1]);
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
	return JSON.parse(trimmed);
};

const stringArray = (value: unknown, max = MAX_REASON_COUNT): string[] =>
	Array.isArray(value) ? uniqueStrings(value.map(String), max) : [];

const normalizeAnalysis = (value: unknown, rating: FeedbackRating, note?: string): FeedbackAnalysis => {
	const source = isRecord(value) ? value : {};
	const repeatedPatterns = Array.isArray(source.repeated_patterns)
		? source.repeated_patterns
				.map((pattern): AnalysisPattern | undefined => {
					if (!isRecord(pattern)) return undefined;
					const text = truncate(String(pattern.text ?? ""));
					if (!text) return undefined;
					return {
						kind: normalizeKind(pattern.kind, rating === "good" || rating === "great" || rating === "perfect" ? "positive" : "negative"),
						text,
						evidence: truncate(String(pattern.evidence ?? "")),
					};
				})
				.filter((pattern): pattern is AnalysisPattern => Boolean(pattern))
				.slice(0, MAX_REASON_COUNT)
		: [];

	const agentsCandidates = Array.isArray(source.agents_candidates)
		? source.agents_candidates
				.map((candidate): AgentsCandidate | undefined => {
					if (!isRecord(candidate)) return undefined;
					const text = truncate(String(candidate.text ?? ""));
					if (!text) return undefined;
					return {
						kind: normalizeCandidateKind(candidate.kind),
						text,
						evidence: truncate(String(candidate.evidence ?? "")),
					};
				})
				.filter((candidate): candidate is AgentsCandidate => Boolean(candidate))
				.slice(0, MAX_REASON_COUNT)
		: [];

	const fallbackSummary = note
		? `User rated the session ${rating} and noted: ${truncate(note, 300)}`
		: `User rated the session ${rating}.`;

	return {
		summary: truncate(String(source.summary ?? fallbackSummary)),
		reasons: stringArray(source.reasons),
		root_causes: stringArray(source.root_causes),
		good_behaviors: stringArray(source.good_behaviors),
		bad_behaviors: stringArray(source.bad_behaviors),
		repeated_patterns: repeatedPatterns,
		memory_suggestions: stringArray(source.memory_suggestions),
		agents_candidates: agentsCandidates,
	};
};

const fallbackAnalysis = (rating: FeedbackRating, note: string | undefined, error: string): FeedbackAnalysis => ({
	summary: note
		? `Feedback recorded as ${rating}; model analysis failed. User note: ${truncate(note, 300)}`
		: `Feedback recorded as ${rating}; model analysis failed.`,
	reasons: note ? [truncate(note)] : [`User selected ${rating}.`],
	root_causes: [truncate(error)],
	good_behaviors: rating === "good" || rating === "great" || rating === "perfect" ? ["Positive rating received."] : [],
	bad_behaviors: rating === "terrible" || rating === "bad" ? ["Negative rating received."] : [],
	repeated_patterns: [],
	memory_suggestions: note ? [`Consider remembering this feedback preference: ${truncate(note)}`] : [],
	agents_candidates: [],
});

const buildAnalysisPrompt = (snapshot: FeedbackSnapshot): string => {
	const knownPatterns = snapshot.knownPatterns
		.map((pattern) => `- [${pattern.kind}] count=${pattern.count} candidate=${pattern.agents_candidate}: ${pattern.text}`)
		.join("\n");

	return [
		"You are pi-feedback analyzing a Pi coding-agent session after explicit user feedback.",
		"Analyze the entire supplied session transcript. Do not ask follow-up questions.",
		"Return JSON only. No markdown fences, no prose outside JSON.",
		"Granulate reasons: give specific, separable reasons tied to behavior, tool use, planning, scope, correctness, or communication.",
		"Memory suggestions must be durable user preferences/workflow rules only; do not include transient project facts.",
		"AGENTS candidates are only candidate rules, not edits. Prefer them only for repeated or high-impact patterns.",
		"For perfect/great feedback, identify behaviors to repeat. For bad/terrible feedback, identify behaviors to avoid.",
		"",
		`Rating: ${snapshot.rating}`,
		snapshot.note ? `User note: ${snapshot.note}` : "User note: none",
		"",
		"Known patterns from previous FEEDBACK.md entries:",
		knownPatterns || "none",
		"",
		"JSON schema:",
		JSON.stringify(
			{
				summary: "one sentence",
				reasons: ["granular reason 1", "granular reason 2"],
				root_causes: ["underlying cause or enabler"],
				good_behaviors: ["behavior to repeat"],
				bad_behaviors: ["behavior to avoid"],
				repeated_patterns: [
					{
						kind: "positive | negative",
						text: "stable pattern name, not a one-off detail",
						evidence: "brief evidence from this session",
					},
				],
				memory_suggestions: ["durable memory suggestion"],
				agents_candidates: [
					{
						kind: "encourage | avoid",
						text: "candidate AGENTS.md rule",
						evidence: "why it might belong there",
					},
				],
			},
			null,
			2,
		),
		"",
		"<session_transcript>",
		snapshot.transcript || "[empty session]",
		"</session_transcript>",
	].join("\n");
};

const runModelAnalysis = async (snapshot: FeedbackSnapshot, ctx: ExtensionCommandContext): Promise<FeedbackAnalysis> => {
	const model = ctx.model;
	if (!model) throw new Error("No active model is available for feedback analysis.");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const { complete } = await import("@earendil-works/pi-ai");
	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildAnalysisPrompt(snapshot) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 2_500,
			temperature: 0,
			timeoutMs: 120_000,
		},
	);

	const text = textFromAssistant(response);
	return normalizeAnalysis(parseJsonObject(text), snapshot.rating, snapshot.note);
};

const mergePatterns = (store: FeedbackStore, analysis: FeedbackAnalysis, at: string): PatternSummary[] => {
	const byId = new Map(store.patterns.map((pattern) => [pattern.id, { ...pattern }]));
	const seenInEntry = new Set<string>();

	for (const pattern of analysis.repeated_patterns) {
		const text = truncate(pattern.text);
		if (!text) continue;
		const id = patternId(pattern.kind, text);
		if (seenInEntry.has(id)) continue;
		seenInEntry.add(id);

		const existing = byId.get(id);
		if (existing) {
			existing.count += 1;
			existing.last_seen = at;
			if (pattern.evidence) {
				existing.evidence_samples = uniqueStrings(
					[pattern.evidence, ...existing.evidence_samples],
					MAX_EVIDENCE_SAMPLES,
				);
			}
			existing.agents_candidate = existing.count >= store.settings.repeated_pattern_threshold;
			byId.set(id, existing);
			continue;
		}

		byId.set(id, {
			id,
			kind: pattern.kind,
			text,
			count: 1,
			first_seen: at,
			last_seen: at,
			agents_candidate: store.settings.repeated_pattern_threshold <= 1,
			evidence_samples: pattern.evidence ? [truncate(pattern.evidence)] : [],
		});
	}

	return [...byId.values()]
		.sort((left, right) => right.count - left.count || right.last_seen.localeCompare(left.last_seen))
		.slice(0, MAX_PATTERN_COUNT);
};

const formatAgentCandidate = (candidate: AgentsCandidate): string =>
	`${candidate.kind}: ${candidate.text}${candidate.evidence ? ` (evidence: ${candidate.evidence})` : ""}`;

const updateEntryWithAnalysis = async (
	snapshot: FeedbackSnapshot,
	analysis: FeedbackAnalysis,
	status: FeedbackEntry["status"],
	error?: string,
): Promise<{ entry: FeedbackEntry; settings: FeedbackSettings }> =>
	updateFeedbackStore(snapshot.cwd, (store) => {
		const at = new Date().toISOString();
		store.patterns = mergePatterns(store, analysis, at);
		const candidatePatterns = store.patterns
			.filter((pattern) => pattern.agents_candidate)
			.map((pattern) => `${pattern.kind === "positive" ? "encourage" : "avoid"}: ${pattern.text} (seen ${pattern.count} times)`);

		let entry = store.entries.find((item) => item.id === snapshot.entryId);
		if (!entry) {
			entry = makePendingEntry(snapshot);
			store.entries.unshift(entry);
		}

		entry.status = status;
		entry.analysis_summary = analysis.summary;
		entry.reasons = uniqueStrings([
			...analysis.reasons,
			...analysis.good_behaviors.map((behavior) => `Repeat: ${behavior}`),
			...analysis.bad_behaviors.map((behavior) => `Avoid: ${behavior}`),
		]);
		entry.root_causes = analysis.root_causes;
		entry.memory_suggestions = analysis.memory_suggestions;
		entry.agents_candidates = uniqueStrings(
			[...analysis.agents_candidates.map(formatAgentCandidate), ...candidatePatterns],
			MAX_PATTERN_COUNT,
		);
		entry.patterns = uniqueStrings(analysis.repeated_patterns.map((pattern) => pattern.text), MAX_PATTERN_COUNT);
		entry.analysis_error = error ? truncate(error) : undefined;

		store.entries = store.entries.slice(0, store.settings.max_entries);
		return { store, result: { entry: { ...entry }, settings: { ...store.settings } } };
	});

const buildFollowUpPrompt = (entry: FeedbackEntry, settings: FeedbackSettings): string | undefined => {
	const sections: string[] = [];

	if (settings.memory_followups && entry.memory_suggestions.length > 0) {
		sections.push(
			[
				"Memory suggestions from /feedback analysis:",
				...entry.memory_suggestions.map((suggestion) => `- ${suggestion}`),
				"If a memory-update tool is available, update durable memory with these suggestions only if they are appropriate.",
				"If no memory tool is available, state that limitation briefly.",
			].join("\n"),
		);
	}

	if (settings.agents_followups && entry.agents_candidates.length > 0) {
		sections.push(
			[
				"AGENTS.md candidates from repeated /feedback patterns:",
				...entry.agents_candidates.map((candidate) => `- ${candidate}`),
				"Do not edit AGENTS.md unless the user explicitly approves; just summarize these candidates for review.",
			].join("\n"),
		);
	}

	if (sections.length === 0) return undefined;
	return [
		"Process these pi-feedback follow-ups. Do not ask follow-up questions.",
		"Keep any response short and action-oriented.",
		"",
		sections.join("\n\n"),
	].join("\n");
};

const maybeQueueFollowUp = (pi: ExtensionAPI, ctx: ExtensionCommandContext, entry: FeedbackEntry, settings: FeedbackSettings): void => {
	const prompt = buildFollowUpPrompt(entry, settings);
	if (!prompt) return;
	try {
		pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`pi-feedback follow-up could not be queued: ${errorMessage(error)}`, "warning");
	}
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const makePendingEntry = (snapshot: FeedbackSnapshot): FeedbackEntry => ({
	id: snapshot.entryId,
	at: new Date().toISOString(),
	rating: snapshot.rating,
	note: snapshot.note,
	status: "pending",
	session_file: snapshot.sessionFile ? basename(snapshot.sessionFile) : undefined,
	session_entries: snapshot.sessionEntries,
	analysis_summary: "Analysis pending.",
	reasons: [],
	root_causes: [],
	memory_suggestions: [],
	agents_candidates: [],
	patterns: [],
});

const createSnapshot = async (
	ctx: ExtensionCommandContext,
	rating: FeedbackRating,
	note: string | undefined,
): Promise<FeedbackSnapshot> => {
	const branch = ctx.sessionManager.getBranch();
	const store = await readFeedbackStore(ctx.cwd);
	return {
		entryId: makeEntryId(),
		rating,
		note,
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionEntries: branch.length,
		transcript: buildSessionTranscript(branch),
		knownPatterns: store.patterns,
	};
};

const analyzeAndPersist = async (pi: ExtensionAPI, ctx: ExtensionCommandContext, snapshot: FeedbackSnapshot): Promise<void> => {
	let analysis: FeedbackAnalysis;
	let status: FeedbackEntry["status"] = "analyzed";
	let analysisError: string | undefined;

	try {
		analysis = await runModelAnalysis(snapshot, ctx);
	} catch (error) {
		analysisError = errorMessage(error);
		analysis = fallbackAnalysis(snapshot.rating, snapshot.note, analysisError);
		status = "analysis_failed";
	}

	const { entry, settings } = await updateEntryWithAnalysis(snapshot, analysis, status, analysisError);
	maybeQueueFollowUp(pi, ctx, entry, settings);

	if (ctx.hasUI) {
		const suffix = status === "analyzed" ? "saved" : "saved with fallback analysis";
		ctx.ui.notify(`pi-feedback ${suffix} to ${FEEDBACK_FILE}`, status === "analyzed" ? "info" : "warning");
	}
};

const submitFeedback = async (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rating: FeedbackRating,
	note?: string,
): Promise<void> => {
	const snapshot = await createSnapshot(ctx, rating, note ? truncate(note) : undefined);

	const settings = await updateFeedbackStore(ctx.cwd, (store) => {
		store.entries.unshift(makePendingEntry(snapshot));
		store.entries = store.entries.slice(0, store.settings.max_entries);
		return { store, result: { ...store.settings } };
	});

	if (ctx.hasUI) {
		ctx.ui.notify(
			`Feedback recorded as ${rating}; analyzing session in background (${settings.memory_followups ? "memory follow-ups on" : "memory follow-ups off"}).`,
			"info",
		);
	}

	void analyzeAndPersist(pi, ctx, snapshot).catch((error) => {
		if (ctx.hasUI) ctx.ui.notify(`pi-feedback analysis failed: ${errorMessage(error)}`, "error");
	});
};

const settingsSummary = (settings: FeedbackSettings): string =>
	`pi-feedback settings: nudges ${settings.nudges ? "on" : "off"}; memory follow-ups ${settings.memory_followups ? "on" : "off"}; AGENTS candidates ${settings.agents_followups ? "on" : "off"}; repeat threshold ${settings.repeated_pattern_threshold}; max entries ${settings.max_entries}.`;

const setSetting = async (
	ctx: ExtensionCommandContext,
	change: (settings: FeedbackSettings) => void,
): Promise<FeedbackSettings> =>
	updateFeedbackStore(ctx.cwd, (store) => {
		const next = normalizeSettings(store.settings);
		change(next);
		store.settings = next;
		return { store, result: { ...next } };
	});

const handleSettingsCommand = async (args: string, ctx: ExtensionCommandContext): Promise<FeedbackSettings | undefined> => {
	const [command, value] = args.trim().split(/\s+/, 2);
	if (!command || command === "status") {
		const store = await readFeedbackStore(ctx.cwd);
		if (ctx.hasUI) ctx.ui.notify(settingsSummary(store.settings), "info");
		return store.settings;
	}

	if (command === "settings") {
		const store = await readFeedbackStore(ctx.cwd);
		if (!ctx.hasUI) return store.settings;
		const choice = await ctx.ui.select("pi-feedback settings", [
			`nudges: ${store.settings.nudges ? "on" : "off"}`,
			`memory follow-ups: ${store.settings.memory_followups ? "on" : "off"}`,
			`AGENTS candidate follow-ups: ${store.settings.agents_followups ? "on" : "off"}`,
			`repeat threshold: ${store.settings.repeated_pattern_threshold}`,
		]);
		if (!choice) return store.settings;
		if (choice.startsWith("nudges:")) return setSetting(ctx, (settings) => (settings.nudges = !settings.nudges));
		if (choice.startsWith("memory")) {
			return setSetting(ctx, (settings) => (settings.memory_followups = !settings.memory_followups));
		}
		if (choice.startsWith("AGENTS")) {
			return setSetting(ctx, (settings) => (settings.agents_followups = !settings.agents_followups));
		}
		if (ctx.hasUI) ctx.ui.notify("Use /feedback threshold <2-10> to change the threshold.", "info");
		return store.settings;
	}

	if (command === "nudges-on") return setSetting(ctx, (settings) => (settings.nudges = true));
	if (command === "nudges-off") return setSetting(ctx, (settings) => (settings.nudges = false));
	if (command === "memory-on") return setSetting(ctx, (settings) => (settings.memory_followups = true));
	if (command === "memory-off") return setSetting(ctx, (settings) => (settings.memory_followups = false));
	if (command === "agents-on") return setSetting(ctx, (settings) => (settings.agents_followups = true));
	if (command === "agents-off") return setSetting(ctx, (settings) => (settings.agents_followups = false));
	if (command === "threshold") {
		const threshold = clampInteger(value, DEFAULT_SETTINGS.repeated_pattern_threshold, 2, 10);
		return setSetting(ctx, (settings) => (settings.repeated_pattern_threshold = threshold));
	}
	if (command === "max-entries") {
		const maxEntries = clampInteger(value, DEFAULT_SETTINGS.max_entries, 5, 50);
		return setSetting(ctx, (settings) => (settings.max_entries = maxEntries));
	}

	return undefined;
};

const parseFeedbackArgs = (args: string): { rating?: FeedbackRating; note?: string; subcommand?: string } => {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const [first = "", ...rest] = trimmed.split(/\s+/);
	if (isFeedbackRating(first)) return { rating: first, note: rest.join(" ").trim() || undefined };
	return { subcommand: trimmed };
};

const helpText = (): string =>
	[
		"Usage: /feedback [terrible|bad|good|great|perfect] [optional note]",
		"No rating opens a picker. The extension records FEEDBACK.md immediately, then analyzes the session in the background.",
		"Settings: /feedback status, /feedback settings, /feedback nudges-on|nudges-off, /feedback memory-on|memory-off, /feedback agents-on|agents-off, /feedback threshold <2-10>.",
	].join("\n");

const shouldNudgeForText = (text: string): boolean => {
	const lower = text.toLowerCase();
	return [
		"that's all",
		"that is all",
		"we're done",
		"we are done",
		"done for now",
		"all set",
		"looks good",
		"thank you",
		"thanks",
		"no more",
		"bye",
		"goodbye",
	].some((phrase) => lower.includes(phrase));
};

const lastUserText = (messages: readonly unknown[]): string => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "user") continue;
		return extractTextParts(message.content).join("\n");
	}
	return "";
};

export default function feedbackExtension(pi: ExtensionAPI) {
	let runtimeSettings: FeedbackSettings = { ...DEFAULT_SETTINGS };
	let feedbackSubmittedInSession = false;
	let lastNudgeAt = 0;

	pi.registerCommand("feedback", {
		description: "Rate the session and record structured feedback",
		getArgumentCompletions: (prefix) => {
			const options = [
				...RATINGS,
				"status",
				"settings",
				"nudges-on",
				"nudges-off",
				"memory-on",
				"memory-off",
				"agents-on",
				"agents-off",
				"threshold",
				"max-entries",
				"help",
			];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseFeedbackArgs(args);

			if (parsed.subcommand === "help") {
				if (ctx.hasUI) ctx.ui.notify(helpText(), "info");
				return;
			}

			if (parsed.subcommand) {
				const settings = await handleSettingsCommand(parsed.subcommand, ctx);
				if (settings) {
					runtimeSettings = settings;
					if (ctx.hasUI && parsed.subcommand !== "status") ctx.ui.notify(settingsSummary(settings), "info");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify(helpText(), "warning");
				return;
			}

			let rating = parsed.rating;
			if (!rating) {
				if (!ctx.hasUI) return;
				const choice = await ctx.ui.select("Rate this pi session", [...RATINGS]);
				if (!choice || !isFeedbackRating(choice)) return;
				rating = choice;
			}

			await submitFeedback(pi, ctx, rating, parsed.note);
			feedbackSubmittedInSession = true;
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		feedbackSubmittedInSession = false;
		lastNudgeAt = 0;
		try {
			const store = await readFeedbackStore(ctx.cwd);
			runtimeSettings = store.settings;
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionName = sessionFile ? basename(sessionFile) : undefined;
			feedbackSubmittedInSession = Boolean(
				sessionName && store.entries.some((entry) => entry.session_file === sessionName && entry.status !== "pending"),
			);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`pi-feedback could not read ${FEEDBACK_FILE}: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		if (!runtimeSettings.nudges || feedbackSubmittedInSession || !ctx.hasUI) return;
		const now = Date.now();
		if (now - lastNudgeAt < 30 * 60 * 1000) return;
		const userText = lastUserText(event.messages);
		if (!shouldNudgeForText(userText)) return;
		lastNudgeAt = now;
		ctx.ui.notify("If this session is done, consider /feedback (terrible, bad, good, great, perfect).", "info");
	});
}
