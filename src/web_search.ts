import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type WebSearchResult = AgentToolResult<unknown>;

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const DEFAULT_RESULTS = 8;
const TIMEOUT_MS = 25_000;
const DDG_HTML = "https://html.duckduckgo.com/html/";
const SEARCH_PROVIDERS = ["auto", "parallel", "perplexity", "gemini", "anthropic", "openai", "xai", "openrouter"] as const;
type SearchProviderId = typeof SEARCH_PROVIDERS[number];

const WebSearchParams = Type.Object({
	query: Type.String({ description: "The search query to perform." }),
	allowedDomains: Type.Optional(Type.Array(Type.String(), { description: "Optional list of domains to restrict search to." })),
});

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function hostMatches(domain: string, urlHost: string): boolean {
	const host = urlHost.replace(/^\[|\]$/g, "").toLowerCase();
	const domainLow = domain.trim().replace(/^\.+/, "").replace(/^\[|\]$/g, "").toLowerCase();
	if (!domainLow) return false;
	return host === domainLow || host.endsWith(`.${domainLow}`);
}

function filterResults(results: SearchResult[], allowed?: string[]): SearchResult[] {
	if (!allowed?.length) return results;
	return results.filter((result) => {
		let host = result.url;
		try {
			host = new URL(result.url).hostname;
		} catch {
			return false;
		}
		return allowed.some((domain) => hostMatches(domain, host));
	});
}

function decodeEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function extractHref(attrsRaw: string): string {
	const match = /href="([^"]*)"/i.exec(attrsRaw);
	if (!match) return "";
	const value = match[1].replaceAll("&amp;", "&").replaceAll("&quot;", "\"").replaceAll("&#x27;", "'");
	const absolute = value.startsWith("//") ? `https:${value}` : value;
	try {
		const parsed = new URL(absolute, "https://duckduckgo.com");
		if (parsed.hostname === "duckduckgo.com") {
			const target = parsed.searchParams.get("uddg");
			if (target) return target;
		}
	} catch {}
	return absolute;
}

function stripTag(value: string): string {
	return decodeEntities(value
		.replace(/<[^>]+>/g, "")
		.replace(/\s{2,}/g, " "))
		.trim();
}

/** DuckDuckGo HTML endpoint: queries without any API key. */
async function searchDuckDuckGo(query: string, allowedDomains?: string[]): Promise<WebSearchResult> {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const searchUrl = `${DDG_HTML}?q=${encodeURIComponent(query)}`;
		const response = await fetch(searchUrl, {
			signal: controller.signal,
			headers: {
				"User-Agent": USER_AGENT,
				"Accept": "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});
		if (!response.ok) {
			return errorResult(`DuckDuckGo returned HTTP ${response.status}`);
		}
		const html = await response.text();
		const blocks = html.match(/<a(?:\s+[^>]*)?class="result__a"[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/div>/g) ?? [];
		for (const block of blocks) {
			if (results.length >= DEFAULT_RESULTS) break;
			const titleRaw = /<a(?:\s+[^>]*)?class="result__a"([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
			const snippetRaw = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
			if (!titleRaw) continue;
			const url = extractHref(titleRaw[1]);
			if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
			try {
				const host = new URL(url).hostname.toLowerCase();
				if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) continue;
			} catch {
				continue;
			}
			const title = stripTag(titleRaw[2]);
			const snippet = snippetRaw ? stripTag(snippetRaw[1]) : "";
			seen.add(url);
			results.push({ title, url, snippet });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return errorResult(message.includes("abort") ? `Web search timed out after ${TIMEOUT_MS / 1000}s` : `Web search failed: ${message}`);
	} finally {
		clearTimeout(timer);
	}

	if (!results.length) {
		return errorResult("No search results parsed (the search provider changed its response format, or the network is blocked). You can fetch a URL directly with web_fetch.");
	}

	const filtered = filterResults(results, allowedDomains);
	if (!filtered.length) {
		return {
			content: [{ type: "text", text: `No results within the allowed domains: ${(allowedDomains ?? []).join(", ")}` }],
			details: { query, count: 0, backend: "duckduckgo" },
		};
	}
	const lines: string[] = [];
	filtered.forEach((result, index) => {
		lines.push(`${index + 1}. [${result.title}](${result.url})`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
	});
	const content = lines.join("\n");
	return {
		content: [{ type: "text", text: content }],
		details: {
			query,
			count: filtered.length,
			backend: "duckduckgo",
			citations: filtered.map((result) => result.url),
		},
	};
}

/** Responses-API backend: same request shape grok-build uses for server-side web search. */
async function searchResponsesApi(query: string, allowedDomains?: string[], baseUrl?: string, apiKey?: string, model?: string): Promise<WebSearchResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const body: Record<string, unknown> = {
			model: model ?? "grok-3-mini",
			input: query,
			store: false,
			max_output_tokens: 8192,
			tools: [{ type: "web_search", filters: allowedDomains?.length ? { allowed_domains: allowedDomains } : {} }],
		};
		const response = await fetch(`${baseUrl!.replace(/\/$/, "")}/responses`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify(body),
		});
		const raw = await response.text();
		if (!response.ok) return errorResult(`Responses API returned HTTP ${response.status}: ${raw.slice(0, 400)}`);
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			return errorResult("Responses API returned non-JSON");
		}
		const citations: string[] = [];
		const seen = new Set<string>();
		const text = extractResponseText(data, citations, seen);
		const content = buildLinksContent(text, citations);
		return {
			content: [{ type: "text", text: content }],
			details: { query, count: citations.length, backend: "responses", citations },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return errorResult(message.includes("abort") ? `Web search timed out after ${TIMEOUT_MS / 1000}s` : `Web search failed: ${message}`);
	} finally {
		clearTimeout(timer);
	}
}

function extractResponseText(data: unknown, citations: string[], seen: Set<string>): string {
	let text = "";
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (record.type === "output_text" && typeof record.text === "string") text += record.text;
		if (record.type === "url_citation") {
			const url = typeof record.url === "string" ? record.url : "";
			if (url && !seen.has(url)) {
				seen.add(url);
				const title = typeof record.title === "string" ? record.title : "";
				citations.push(`${title}\u0000${url}`);
			}
		}
		for (const key of Object.keys(record)) walk(record[key]);
	};
	walk(data);
	return text;
}

function buildLinksContent(text: string, citations: string[]): string {
	const lines = [text.trim() || "No search results found."];
	if (citations.length) {
		lines.push("", "Links:");
		citations.forEach((entry, index) => {
			const [title, url] = entry.split("\u0000");
			lines.push(`${index + 1}. [${title}](${url})`);
		});
	}
	return lines.join("\n");
}

function errorResult(message: string): WebSearchResult {
	return { content: [{ type: "text", text: `ERROR: ${message}` }], details: { error: message } };
}

function preferredSearchProvider(): SearchProviderId {
	const agentDir = process.env.TSUKUYOMI_DIR || process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) return "auto";
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "tsukuyomi.json"), "utf8"));
		const selected = String(settings?.webSearchProvider || "auto").toLowerCase();
		return SEARCH_PROVIDERS.includes(selected as SearchProviderId) ? selected as SearchProviderId : "auto";
	} catch { return "auto"; }
}

function searchApiKey(provider: Exclude<SearchProviderId, "auto">): string | undefined {
	const variables: Record<string, string[]> = {
		parallel: ["PARALLEL_API_KEY"], perplexity: ["PERPLEXITY_API_KEY"],
		gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], anthropic: ["ANTHROPIC_API_KEY"],
		openai: ["OPENAI_API_KEY"], xai: ["XAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY"],
	};
	for (const name of variables[provider] || []) if (process.env[name]) return process.env[name];
	const agentDir = process.env.TSUKUYOMI_DIR || process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) return undefined;
	try {
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
		const aliases = provider === "gemini" ? ["google", "gemini"] : [provider];
		for (const id of aliases) {
			const record = auth?.[id];
			if (record?.type === "api_key" && typeof record.key === "string" && record.key.trim()) return record.key.trim();
		}
	} catch { /* Missing or malformed auth is reported by the selected provider. */ }
	return undefined;
}

function searchResult(query: string, provider: string, answer: string, sources: SearchResult[], model?: string): WebSearchResult {
	const unique = [...new Map(sources.filter((item) => /^https?:\/\//.test(item.url)).map((item) => [item.url, item])).values()];
	const lines = [answer.trim(), ...(unique.length ? ["", "Sources:", ...unique.map((item, index) => `${index + 1}. [${item.title || item.url}](${item.url})${item.snippet ? ` — ${item.snippet}` : ""}`)] : [])];
	return { content: [{ type: "text", text: lines.join("\n").trim() || "No search results found." }], details: { query, provider, model, count: unique.length, citations: unique.map((item) => item.url) } };
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
	const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
	const raw = await response.text();
	if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(raw);
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const event = JSON.parse(line.slice(5).trim());
			if (event?.jsonrpc === "2.0" && (event.result || event.error)) return event;
		} catch { /* keep scanning */ }
	}
	throw new Error("MCP search returned no JSON-RPC result");
}

async function searchParallel(query: string, key?: string): Promise<WebSearchResult> {
	let payload: any;
	if (key) {
		payload = await postJson("https://api.parallel.ai/v1beta/search", { objective: query, search_queries: [query], max_results: 10 }, { "x-api-key": key, "parallel-beta": "search-extract-2025-10-10" });
	} else {
		const rpc = await postJson("https://search.parallel.ai/mcp", { jsonrpc: "2.0", id: "tsukuyomi-search", method: "tools/call", params: { name: "web_search", arguments: { objective: query, search_queries: [query] } } }, { Accept: "application/json, text/event-stream" });
		payload = rpc?.result?.structuredContent;
		if (!payload) {
			const block = rpc?.result?.content?.find((item: any) => item?.type === "text");
			payload = block?.text ? JSON.parse(block.text) : undefined;
		}
	}
	const sources = (Array.isArray(payload?.results) ? payload.results : []).map((item: any) => ({ title: String(item.title || item.url || ""), url: String(item.url || ""), snippet: String(item.excerpts?.join(" ") || item.snippet || "") }));
	return searchResult(query, "parallel", "", sources);
}

async function searchPerplexity(query: string, key: string): Promise<WebSearchResult> {
	const model = process.env.TSUKUYOMI_PERPLEXITY_MODEL || "sonar-pro";
	const data = await postJson("https://api.perplexity.ai/chat/completions", { model, messages: [{ role: "user", content: query }] }, { Authorization: `Bearer ${key}` });
	const answer = String(data?.choices?.[0]?.message?.content || "");
	const sources = (Array.isArray(data?.citations) ? data.citations : []).map((item: any) => ({ title: String(item.title || item.url || item), url: String(item.url || item), snippet: String(item.snippet || "") }));
	return searchResult(query, "perplexity", answer, sources, model);
}

async function searchGemini(query: string, key: string): Promise<WebSearchResult> {
	const model = process.env.TSUKUYOMI_GEMINI_SEARCH_MODEL || "gemini-2.5-flash";
	const data = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { contents: [{ parts: [{ text: query }] }], tools: [{ googleSearch: {} }] }, { "x-goog-api-key": key });
	const candidate = data?.candidates?.[0];
	const answer = (candidate?.content?.parts || []).map((item: any) => item?.text || "").join("\n");
	const sources = (candidate?.groundingMetadata?.groundingChunks || []).map((item: any) => ({ title: String(item?.web?.title || item?.web?.uri || ""), url: String(item?.web?.uri || ""), snippet: "" }));
	return searchResult(query, "gemini", answer, sources, model);
}

async function searchAnthropic(query: string, key: string, allowedDomains?: string[]): Promise<WebSearchResult> {
	const model = process.env.TSUKUYOMI_ANTHROPIC_SEARCH_MODEL || "claude-sonnet-4-5";
	const data = await postJson("https://api.anthropic.com/v1/messages", { model, max_tokens: 4096, messages: [{ role: "user", content: query }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5, ...(allowedDomains?.length ? { allowed_domains: allowedDomains } : {}) }] }, { "x-api-key": key, "anthropic-version": "2023-06-01" });
	const answer = (data?.content || []).filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
	const sources = (data?.content || []).flatMap((item: any) => (item?.citations || []).map((citation: any) => ({ title: String(citation.title || citation.url || ""), url: String(citation.url || ""), snippet: "" })));
	return searchResult(query, "anthropic", answer, sources, model);
}

async function searchOpenRouter(query: string, key: string): Promise<WebSearchResult> {
	const model = process.env.TSUKUYOMI_OPENROUTER_SEARCH_MODEL || "openai/gpt-4o-mini";
	const data = await postJson("https://openrouter.ai/api/v1/chat/completions", { model, messages: [{ role: "user", content: query }], plugins: [{ id: "web", max_results: 10 }] }, { Authorization: `Bearer ${key}` });
	const message = data?.choices?.[0]?.message;
	const answer = typeof message?.content === "string" ? message.content : (message?.content || []).map((item: any) => item?.text || "").join("\n");
	const sources = (message?.annotations || []).map((item: any) => ({ title: String(item?.url_citation?.title || item?.url_citation?.url || ""), url: String(item?.url_citation?.url || ""), snippet: String(item?.url_citation?.content || "") }));
	return searchResult(query, "openrouter", answer, sources, model);
}

async function searchSelected(provider: SearchProviderId, query: string, allowed?: string[]): Promise<WebSearchResult> {
	const key = provider === "auto" ? undefined : searchApiKey(provider);
	if (provider === "parallel") return searchParallel(query, key);
	if (provider === "perplexity" && key) return searchPerplexity(query, key);
	if (provider === "gemini" && key) return searchGemini(query, key);
	if (provider === "anthropic" && key) return searchAnthropic(query, key, allowed);
	if (provider === "openai" && key) return searchResponsesApi(query, allowed, "https://api.openai.com/v1", key, process.env.TSUKUYOMI_OPENAI_SEARCH_MODEL || "gpt-4.1-mini");
	if (provider === "xai" && key) return searchResponsesApi(query, allowed, "https://api.x.ai/v1", key, process.env.TSUKUYOMI_XAI_SEARCH_MODEL || "grok-4");
	if (provider === "openrouter" && key) return searchOpenRouter(query, key);
	return errorResult(`${provider} needs credentials. Configure its API key or choose Auto.`);
}

export function registerWebSearch(pi: ExtensionAPI): void {
	// TSUKUYOMI_* wins; the legacy KAGUYAPI_* names are honoured once.
	const baseUrl = process.env.TSUKUYOMI_WEBSEARCH_URL || process.env.KAGUYAPI_WEBSEARCH_URL;
	const apiKey = process.env.TSUKUYOMI_WEBSEARCH_KEY || process.env.KAGUYAPI_WEBSEARCH_KEY || process.env.XAI_API_KEY || process.env.OPENAI_API_KEY;
	const model = process.env.TSUKUYOMI_WEBSEARCH_MODEL || process.env.KAGUYAPI_WEBSEARCH_MODEL;
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for up-to-date information, tailored for coding and software development tasks. Returns results with links; follow them with web_fetch for details.",
		promptSnippet: "Search the web for up-to-date information, then follow relevant links with web_fetch.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params) {
			const query = String(params.query ?? "").trim();
			if (!query) return errorResult("query is required");
			const allowed = Array.isArray(params.allowedDomains)
				? params.allowedDomains.map(String).filter(Boolean) : undefined;
			if (baseUrl) return searchResponsesApi(query, allowed, baseUrl, apiKey, model);
			const selected = preferredSearchProvider();
			if (selected !== "auto") {
				try { return await searchSelected(selected, query, allowed); }
				catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
			}
			for (const candidate of ["perplexity", "gemini", "anthropic", "openai", "xai", "openrouter", "parallel"] as const) {
				if (candidate !== "parallel" && !searchApiKey(candidate)) continue;
				try {
					const result = await searchSelected(candidate, query, allowed);
					if (!result.details || !(result.details as any).error) return result;
				} catch { /* try the next configured search provider */ }
			}
			return searchDuckDuckGo(query, allowed);
		},
	});
}
