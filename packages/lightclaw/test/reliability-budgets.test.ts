import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { budgetOperation, PersistentModelBudget } from "../src/evals/reliability/budget-ledger.js";

const roots: string[] = [];
const limits = {
	requests: 3,
	tokens: 300,
	costMicros: 3000,
	wallMs: 1000,
	tokensPerRequest: 100,
	costMicrosPerRequest: 1000,
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() {
	const root = mkdtempSync(join(tmpdir(), "reliability-budget-"));
	roots.push(root);
	return join(root, "budget.json");
}
it("counts reservations and settled usage across restart including candidate costs", () => {
	const file = path();
	const first = new PersistentModelBudget(file, limits, () => 0);
	first.reserve("faux/model", "candidate_generation"); // crash leaves unknown usage, never zero
	const restarted = new PersistentModelBudget(file, limits, () => 10);
	const second = restarted.reserve("faux/model", "selection");
	restarted.settle(second, 20, 200);
	expect(restarted.snapshot()).toMatchObject({ requests: 2, chargedTokens: 120, chargedCostMicros: 1200, unknown: 1 });
	restarted.reserve("faux/model", "task");
	expect(() => restarted.reserve("faux/model", "task")).toThrow(/budget/i);
});
it("does not reset wall clock on restart or silently change approved ceilings", () => {
	const file = path();
	new PersistentModelBudget(file, limits, () => 0).reserve("faux/model", "task");
	expect(() => new PersistentModelBudget(file, limits, () => 1001).reserve("faux/model", "task")).toThrow(/wall/i);
	expect(() => new PersistentModelBudget(file, { ...limits, requests: 100 }, () => 10)).toThrow(/limit|ceiling/i);
});
it("stops permanently after a provider exceeds its reservation and rejects double settlement", () => {
	const budget = new PersistentModelBudget(path(), limits, () => 0);
	const id = budget.reserve("faux/model", "task");
	expect(() => budget.settle(id, 101, 100)).toThrow(/reservation/i);
	expect(() => budget.reserve("faux/model", "task")).toThrow();
	const next = new PersistentModelBudget(path(), limits, () => 0);
	const good = next.reserve("faux/model", "task");
	next.settle(good, 10, 10);
	expect(() => next.settle(good, 10, 10)).toThrow();
});

it("does not report unmeasured human effort as zero", () => {
	const budget = new PersistentModelBudget(path(), limits, () => 0);
	expect(budget.snapshot().humanMinutes).toBeNull();
	budget.recordHumanMinutes(2);
	expect(budget.snapshot().humanMinutes).toBe(2);
	budget.recordHumanMinutes(3);
	expect(budget.snapshot().humanMinutes).toBe(5);
});

it("waits for live transaction contention but never steals a stale lock", async () => {
	const file = path();
	const budget = new PersistentModelBudget(file, limits, () => 0);
	const lock = join(file, "..", ".budget.lock");
	mkdirSync(lock);
	const pending = budgetOperation(() => budget.reserve("faux/model", "task"), undefined, 500);
	setTimeout(() => rmSync(lock, { recursive: true }), 30);
	expect(await pending).toBeTruthy();
	mkdirSync(lock);
	await expect(budgetOperation(() => budget.reserve("faux/model", "task"), undefined, 30)).rejects.toThrow(/lock/i);
});

it("rejects unsupported budget fields and impossible per-request ceilings before any request", () => {
	expect(() => new PersistentModelBudget(path(), { ...limits, tokensPerRequest: 301 })).toThrow();
	expect(() => new PersistentModelBudget(path(), { ...limits, extra: 1 } as typeof limits)).toThrow();
});

it("fails closed on corrupted reserved usage rather than reducing unknown allowance", () => {
	const file = path();
	const budget = new PersistentModelBudget(file, limits, () => 0);
	budget.reserve("faux/model", "task");
	const state = JSON.parse(readFileSync(file, "utf8"));
	state.entries[0].tokens = 1;
	writeFileSync(file, JSON.stringify(state));
	expect(() => new PersistentModelBudget(file, limits, () => 0).snapshot()).toThrow(/corrupt/i);
});
