export function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
}

export function assertText(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
}

export function assertCount(value: unknown, field: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} 必须是非负安全整数`);
	}
}

export function assertTextArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
	for (const [index, item] of value.entries()) assertText(item, `${field}[${index}]`);
}
