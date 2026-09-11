import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type WebSearchResult = AgentToolResult<unknown>;

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const DEFAULT_RESULTS = 8;
const TIMEOUT_MS = 25_000;
const DDG_HTML = "https://html.duckduckgo.com/html/";

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
			temperature: 0.1,
			top_p: 0.95,
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
			return searchDuckDuckGo(query, allowed);
		},
	});
}
