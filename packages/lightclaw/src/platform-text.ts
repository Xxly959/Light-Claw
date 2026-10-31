/** Conservative preview limits; authoritative responses stay in the local session. */
export function fitPlatformText(text: string, kind: "slack" | "feishu"): string {
	const fits = (value: string) =>
		kind === "slack" ? value.length <= 35_000 : Buffer.byteLength(JSON.stringify({ text: value }), "utf8") <= 18_000;
	if (fits(text)) return text;
	const suffix = "\n\n[消息已截断，请在本地会话查看完整结果]";
	let low = 0,
		high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(text.slice(0, mid) + suffix)) low = mid;
		else high = mid - 1;
	}
	let prefix = text.slice(0, low);
	if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
	return prefix + suffix;
}
