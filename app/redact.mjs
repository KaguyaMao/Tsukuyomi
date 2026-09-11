const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;
const SENSITIVE_QUERY = /(?:api[_-]?key|token|secret|authorization|password)/i;
const SECRET = "[REDACTED]";

export function redact(value) {
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? SECRET : redact(item)]));
	return value;
}

export function redactText(value) {
	return String(value)
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]@")
		.replace(/([?&](?:api[_-]?key|token|secret|authorization|password)=)[^&#\s]*/gi, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*)[^\s,}"']+/gi, "$1[REDACTED]");
}

export { SECRET };
