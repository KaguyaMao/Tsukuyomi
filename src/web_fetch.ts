import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type WebFetchResult = AgentToolResult<unknown>;

const MAX_URL_LENGTH = 4_096;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_CHARS = 120_000;
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const ACCEPT = "text/markdown,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "iframe", "object", "embed"]);
const NOISE_TAGS = new Set(["nav", "header", "footer"]);
const NOISE_MARKERS = ["cookie", "sidebar", "ad-", "advert"];

const WebFetchParams = Type.Object({
	url: Type.String({ description: "The URL to fetch content from." }),
});

interface WebFetchConfig {
	allowedDomains?: string[];
	allowLocal?: boolean;
	timeoutMs?: number;
	maxBytes?: number;
	maxChars?: number;
}

const ENTITY_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	"#39": "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	laquo: "«",
	raquo: "»",
	copy: "©",
};
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;

function unescapeEntities(value: string): string {
	return value.replace(ENTITY_RE, (_match, decimal: string, hex: string, named: string) => {
		if (decimal) return String.fromCodePoint(Number(decimal));
		if (hex) return String.fromCodePoint(parseInt(hex, 16));
		return ENTITY_MAP[named] ?? "";
	});
}

function stripBase64DataUris(content: string): string {
	if (!content.includes("data:")) return content;
	const stripped = content
		.replace(/!\[[^\]]*\]\(data:[^,;\s]{0,80};base64,[A-Za-z0-9+/=]+\)/gi, "[base64 data removed]")
		.replace(/data:[^,;\s]{0,80};base64,[A-Za-z0-9+/=]+/gi, "[base64 data removed]");
	return stripped;
}

interface DomNode {
	name: string;
	attrs: Record<string, string>;
	children: Array<DomNode | string>;
}

function parseTree(html: string): DomNode {
	const root: DomNode = { name: "#root", attrs: {}, children: [] };
	const stack: DomNode[] = [root];
	for (const token of tokenize(html)) {
		if (token.type === "data") {
			stack[stack.length - 1].children.push(token.text as string);
			continue;
		}
		if (token.type === "comment") continue;
		if (token.type === "close") {
			for (let index = stack.length - 1; index > 0; index--) {
				if (stack[index].name === token.name) {
					stack.length = index;
					break;
				}
			}
			continue;
		}
		const node: DomNode = { name: token.name, attrs: token.attrs ?? {}, children: [] };
		stack[stack.length - 1].children.push(node);
		if (token.selfClosing || VOID_TAGS.has(token.name)) continue;
		stack.push(node);
	}
	return root;
}

const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link", "source", "wbr"]);

interface RawToken {
	type: "data" | "open" | "close" | "comment";
	name: string;
	text?: string;
	attrs?: Record<string, string>;
	selfClosing?: boolean;
}

function tokenize(html: string): RawToken[] {
	const tokens: RawToken[] = [];
	const pattern = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<!doctype[^>]*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		if (match.index > last && match.index - last < 20_000_000) {
			tokens.push({ type: "data", name: "#text", text: html.slice(last, match.index) });
		}
		last = pattern.lastIndex;
		if (match[0].startsWith("<!--")) { tokens.push({ type: "comment", name: "#comment" }); continue; }
		if (match[0].startsWith("</")) { tokens.push({ type: "close", name: match[1].toLowerCase() }); continue; }
		if (match[0].toLowerCase().startsWith("<!doctype")) continue;
		tokens.push(makeOpenToken(match[2], match[3], Boolean(match[4])));
	}
	if (last < html.length) tokens.push({ type: "data", name: "#text", text: html.slice(last) });
	return tokens;
}

function makeOpenToken(name: string, raw: string, selfClosing: boolean): RawToken {
	const attrs: Record<string, string> = {};
	const attrPattern = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = attrPattern.exec(raw ?? "")) !== null) {
		attrs[m[1].toLowerCase()] = unescapeEntities(m[2] ?? m[3] ?? m[4] ?? "");
	}
	return { type: "open", name: name.toLowerCase(), attrs, selfClosing };
}

const INLINE_OPEN: Record<string, string> = { a: "[", code: "`", b: "**", strong: "**", i: "*", em: "*" };
const INLINE_CLOSE: Record<string, string> = { a: "]", code: "`", b: "**", strong: "**", i: "*", em: "*" };

function renderChildren(node: DomNode, out: string[], baseUrl: string): void {
	for (const child of node.children) {
		if (typeof child === "string") out.push(child);
		else renderNode(child, out, baseUrl);
	}
}

function renderNode(node: DomNode, out: string[], baseUrl: string): void {
	if (node.children.length === 0) return;
	if (node.name === "#root") {
		renderChildren(node, out, baseUrl);
		return;
	}
	if (SKIP_TAGS.has(node.name) || NOISE_TAGS.has(node.name) || hasNoiseAttr(node.attrs)) return;
	const inlineOpen = INLINE_OPEN[node.name];
	if (inlineOpen !== undefined || INLINE_CLOSE[node.name] !== undefined) {
		out.push(inlineOpen ?? "");
		renderChildren(node, out, baseUrl);
		if (node.name === "a") {
			const href = node.attrs.href ?? "";
			if (href && !/^(?:data|javascript):/i.test(href)) {
				try { out.push(`](${new URL(href, baseUrl).toString().replaceAll(" ", "%20")})`); } catch {}
			}
		} else {
			out.push(INLINE_CLOSE[node.name] ?? "");
		}
		return;
	}
	switch (node.name) {
		case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
			out.push(`\n${"#".repeat(Number(node.name[1]))} `);
			renderChildren(node, out, baseUrl);
			out.push("\n");
			return;
		case "p": case "div": case "section": case "article": case "main":
		case "blockquote": case "ul": case "ol": case "table": case "tbody":
			out.push("\n");
			renderChildren(node, out, baseUrl);
			out.push("\n");
			return;
		case "li":
			out.push("\n- ");
			renderChildren(node, out, baseUrl);
			return;
		case "tr":
			out.push("\n|");
			renderChildren(node, out, baseUrl);
			return;
		case "td": case "th":
			out.push(" ");
			renderChildren(node, out, baseUrl);
			out.push(" |");
			return;
		case "pre":
			out.push("\n```\n");
			renderChildren(node, out, baseUrl);
			out.push("\n```\n");
			return;
		case "br":
			out.push("\n");
			return;
		case "hr":
			out.push("\n---\n");
			return;
		case "img": {
			const src = node.attrs.src ?? "";
			if (src && !/^data:/i.test(src)) {
				try { out.push(`![${node.attrs.alt ?? ""}](${new URL(src, baseUrl).toString().replaceAll(" ", "%20")})`); } catch {}
			}
			return;
		}
		default:
			renderChildren(node, out, baseUrl);
			return;
	}
}

function hasNoiseAttr(attrs: Record<string, string>): boolean {
	const value = `${attrs.class ?? ""} ${attrs.id ?? ""}`.toLowerCase();
	return NOISE_MARKERS.some((marker) => value.includes(marker));
}

function htmlToMarkdown(html: string, baseUrl: string): string {
	try {
		const root = parseTree(html);
		const out: string[] = [];
		renderNode(root, out, baseUrl);
		return out
			.join("")
			.replace(/\[\s*\]\([^)]*\)/g, "")
			.replace(/\n[ \t]+/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	} catch {
		return stripTags(html);
	}
}

/** Last-resort fallback: strip tags roughly without parsing. */
function stripTags(html: string): string {
	const detached = html
		.replace(/<(script|style|noscript|svg|iframe|object|embed)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<[^>]+>/g, " ");
	return unescapeEntities(detached.replace(/\s{2,}/g, " "));
}

function isPrivateIpv4(value: string): boolean {
	const parts = value.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b, c] = parts;
	return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168 || (b === 2 && c === 0))) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) || a >= 224;
}

function mappedIpv4(ip: string): string | undefined {
	const low = ip.toLowerCase();
	const dotted = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
	if (dotted) return dotted[1];
	const hex = /(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
	if (!hex) return undefined;
	const high = parseInt(hex[1], 16);
	const lowWord = parseInt(hex[2], 16);
	const value = high * 0x10000 + lowWord;
	return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function isPrivateIpv6(value: string): boolean {
	const ip = value.toLowerCase();
	const embedded = mappedIpv4(ip);
	if (embedded) return isPrivateIpv4(embedded);
	return ip === "::" || ip === "::1" || /^fc|^fd|^fe[89ab]|^ff|^2001:db8:/i.test(ip);
}

function isPrivateHost(host: string, ip: string): boolean {
	if (isIP(ip) === 4) return isPrivateIpv4(ip) || (isIP(host) === 4 && isPrivateIpv4(host));
	if (isIP(ip) === 6) return isPrivateIpv6(ip) || (isIP(host) === 6 && isPrivateIpv6(host));
	return true;
}

function isExplicitLocalHost(host: string): boolean {
	const low = host.toLowerCase().replace(/^\[|\]$/g, "");
	return low === "localhost" || low.endsWith(".localhost") || low === "::1" || /^127\.\d+\.\d+\.\d+$/.test(low) || low === "0.0.0.0";
}

async function checkSsrF(url: string, config: WebFetchConfig): Promise<void> {
	const parsed = new URL(url);
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	if (isExplicitLocalHost(host)) {
		if (config.allowLocal) return;
		throw new Error("Refusing to fetch a local address (set tsukuyomi-web.json allowLocal=true to permit)");
	}
	const hostIpType = isIP(host);
	if (hostIpType === 6 && isPrivateIpv6(host) && !config.allowLocal) {
		throw new Error(`Refusing to fetch private address ${host}`);
	}
	if (hostIpType === 0 && !host.includes(".")) {
		if (config.allowLocal) return;
		throw new Error(`Refusing to fetch single-label host "${host}"`);
	}
	if (config.allowedDomains?.length) {
		const hostLower = host.toLowerCase();
		const ok = config.allowedDomains.some((domain) => {
			const normalized = domain.trim().toLowerCase().replace(/^\.+/, "");
			return normalized && (hostLower === normalized || hostLower.endsWith(`.${normalized}`));
		});
		if (!ok) throw new Error(`Domain "${host}" is not in allowedDomains`);
	}
	let addresses: string[] = [];
	try {
		const resolved = await lookup(host, { all: true });
		addresses = resolved.map((entry) => entry.address);
	} catch {
		throw new Error(`Could not resolve host "${host}"`);
	}
	if (!addresses.length) throw new Error(`Could not resolve host "${host}"`);
	for (const address of addresses) {
		if (!config.allowLocal && isPrivateHost(host, address)) {
			throw new Error(`Refusing to fetch private address ${address} for host "${host}"`);
		}
	}
}

function errorResult(message: string): WebFetchResult {
	return { content: [{ type: "text", text: `ERROR: ${message}` }], details: { error: message } };
}

export function registerWebFetch(pi: ExtensionAPI): void {
	const config = loadConfig();
	pi.registerTool({
		name: "web_fetch",
		label: "Fetch web page",
		description:
			"Fetch the content of a specific URL and return it as text or markdown. For public web pages and documentation only — authenticated or private URLs (Google Docs, Confluence, Jira, private repos) will fail; use specialized tools instead. HTTP URLs are upgraded to HTTPS. Long pages are truncated to fit the context window.",
		promptSnippet: "Fetch web pages as markdown for research and up-to-date information.",
		parameters: WebFetchParams,
		async execute(_toolCallId, params) {
			try {
				return await fetchUrl(String(params.url ?? ""), config);
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	});
}

async function fetchUrl(rawUrl: string, config: WebFetchConfig): Promise<WebFetchResult> {
	if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
		return errorResult(`URL is empty or exceeds ${MAX_URL_LENGTH} characters`);
	}
	const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
	let current = rawUrl.trim();
	let hops = 0;
	const visited = new Set<string>();

	while (true) {
		let url: URL;
		try {
			url = new URL(current);
		} catch {
			return errorResult(`Invalid URL: ${current}`);
		}
		if (url.username || url.password) return errorResult("URL must not contain credentials");
		if (url.protocol !== "http:" && url.protocol !== "https:") return errorResult(`Unsupported scheme: ${url.protocol}`);
		if (url.protocol === "http:" && !isExplicitLocalHost(url.hostname)) url.protocol = "https:";
		current = url.toString();
		if (visited.has(current) || hops > MAX_REDIRECTS) return errorResult(`Too many redirects (max ${MAX_REDIRECTS})`);
		visited.add(current);

		let response: Response;
		try {
			await checkSsrF(current, config);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);
			try {
				response = await fetch(current, {
					redirect: "manual",
					signal: controller.signal,
					headers: {
						"User-Agent": USER_AGENT,
						Accept: ACCEPT,
						"Accept-Language": "en-US,en;q=0.9",
					},
				});
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResult(message.includes("abort") ? `Request timed out after ${Math.round(timeout / 1000)}s` : message);
		}

		if (response.status >= 300 && response.status < 400) {
			hops += 1;
			const location = response.headers.get("location");
			if (!location) return errorResult(`Redirect without Location header (${response.status})`);
			let next: URL;
			try {
				next = new URL(location, url);
			} catch {
				return errorResult(`Invalid redirect target: ${location}`);
			}
			if (next.hostname !== url.hostname) {
				return {
					content: [{
						type: "text",
						text: `Cross-host redirect from ${url.hostname} to ${next.hostname} was not followed automatically. Re-fetch the target URL directly if needed: ${next.toString()}`,
					}],
					details: { url: current, crossHostRedirect: next.toString() },
				};
			}
			current = next.toString();
			continue;
		}

		const contentType = response.headers.get("content-type") ?? "text/html";
		const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
		const declaredLength = Number(response.headers.get("content-length") ?? 0);
		if (declaredLength && declaredLength > maxBytes) {
			return errorResult(`Response too large (${declaredLength} bytes, max ${maxBytes})`);
		}

		let buffer: ArrayBuffer;
		try {
			buffer = await readResponseBody(response, maxBytes);
		} catch (error) {
			return errorResult(`Failed to read response body: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (buffer.byteLength > maxBytes) return errorResult(`Response too large (${buffer.byteLength} bytes, max ${maxBytes})`);

		if (response.status >= 400) {
			const body = new TextDecoder().decode(buffer).slice(0, 300).replace(/\s+/g, " ");
			return errorResult(`HTTP ${response.status} ${response.statusText}${body ? ` — ${body}` : ""} (${current})`);
		}

		if (/^(image|audio|video)\//.test(mime) || mime === "application/pdf") {
			return {
				content: [{
					type: "text",
					text: `Fetched binary content (${mime}, ${buffer.byteLength} bytes) — not inlined. Open ${current} in a browser or use a suitable tool instead.`,
				}],
				details: { url: current, contentType: mime, bytes: buffer.byteLength, kind: "binary" },
			};
		}

		let text = new TextDecoder().decode(buffer);
		const isHtml = mime.includes("text/html") || mime.includes("application/xhtml");
		if (isHtml) {
			text = htmlToMarkdown(text, current);
			text = unescapeEntities(text);
		}
		text = stripBase64DataUris(text);

		const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
		const truncated = text.length > maxChars;
		if (truncated) {
			const cut = Math.max(0, text.slice(0, maxChars).lastIndexOf("\n"));
			text = `${text.slice(0, cut > 0 ? cut : maxChars)}\n\n[… truncated: ${text.length - maxChars} more characters …]`;
		}

		return {
			content: [{ type: "text", text: text || "(empty page)" }],
			details: {
				url: current,
				finalUrl: current,
				contentType: mime,
				status: response.status,
				bytes: buffer.byteLength,
				truncated,
			},
		};
	}
}

async function readResponseBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
	if (!response.body) return response.arrayBuffer();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error(`Response exceeds ${maxBytes} bytes`);
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const buffer = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffer.buffer;
}

function loadConfig(): WebFetchConfig {
	let raw: Partial<WebFetchConfig> = {};
	const root = process.env.TSUKUYOMI_DIR || process.env.PI_CODING_AGENT_DIR;
	if (root) {
		// New name first; the legacy filename is read once for in-place upgrades.
		for (const name of ["tsukuyomi-web.json", "kaguya-web.json"]) {
			try {
				raw = JSON.parse(readFileSync(`${root}/${name}`, "utf8")) as Partial<WebFetchConfig>;
				break;
			} catch {
				// Missing or invalid config is fine; try the next name, then defaults.
			}
		}
	}
	return {
		allowedDomains: Array.isArray(raw.allowedDomains) ? raw.allowedDomains.map(String).map((value) => value.trim()).filter(Boolean) : undefined,
		allowLocal: Boolean(raw.allowLocal),
		timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
		maxBytes: typeof raw.maxBytes === "number" ? raw.maxBytes : undefined,
		maxChars: typeof raw.maxChars === "number" ? raw.maxChars : undefined,
	};
}
