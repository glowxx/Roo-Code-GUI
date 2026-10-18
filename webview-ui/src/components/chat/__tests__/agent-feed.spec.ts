import type { ClineMessage } from "@roo-code/types"
import { buildAgentFeed, getAgentActivityLabel } from "../agent-feed"

const say = (ts: number, type: ClineMessage["say"], text = ""): ClineMessage => ({ ts, type: "say", say: type, text })
const ask = (ts: number, type: ClineMessage["ask"], extra: Partial<ClineMessage> = {}): ClineMessage => ({
	ts,
	type: "ask",
	ask: type,
	...extra,
})

describe("agent conversation projection", () => {
	it("keeps interrupted responses visible even when a resume marker was filtered out", () => {
		expect(
			buildAgentFeed([
				say(
					1,
					"api_req_started",
					JSON.stringify({ cancelReason: "streaming_failed", streamingFailedMessage: "disconnected" }),
				),
			])[0].kind,
		).toBe("message")
	})
	it("describes a provider wait without pretending that project work is progressing", () => {
		expect(getAgentActivityLabel([ask(1, "command"), say(2, "api_req_rate_limit_wait")])).toBe(
			"Waiting for model availability",
		)
	})
	it("keeps original messages, ordering and milestones while grouping consecutive technical events", () => {
		const messages = [
			say(1, "text", "Sprawdzę obsługę logowania."),
			say(2, "api_req_started"),
			ask(3, "tool", { isAnswered: true, text: JSON.stringify({ tool: "readFile", path: "login.ts" }) }),
			say(4, "command_output", "private terminal output"),
			say(5, "text", "Znalazłem brakującą walidację."),
			say(6, "reasoning"),
			say(7, "completion_result", "Walidacja została poprawiona."),
		]
		const feed = buildAgentFeed(messages)
		expect(feed.map((item) => item.kind)).toEqual(["message", "activity", "message", "activity", "message"])
		expect(feed.flatMap((item) => (item.kind === "activity" ? item.messages : item.message))).toEqual(messages)
		expect(messages).toHaveLength(7)
	})
	it.each(["tool", "command", "use_mcp_server", "command_output"] as const)(
		"never folds the pending %s decision",
		(type) => {
			const pending = ask(2, type, { approvalState: "USER_DECISION_REQUIRED" })
			const feed = buildAgentFeed([say(1, "reasoning"), pending, say(3, "command_safety_warning")], 2)
			expect(feed.find((item) => item.ts === 2)).toEqual({ kind: "message", ts: 2, message: pending })
		},
	)
	it.each(["AUTO_APPROVED", "EVALUATING", "DENIED"] as const)(
		"keeps %s execution out of the decision surface",
		(approvalState) => {
			expect(buildAgentFeed([ask(1, "command", { approvalState })], 1)[0].kind).toBe("activity")
		},
	)
	it("keeps the current unresolved error visible but puts recovered failures in the log", () => {
		expect(buildAgentFeed([say(1, "error", "ENOENT")])[0].kind).toBe("message")
		expect(buildAgentFeed([say(1, "error", "ENOENT"), say(2, "text", "Sprawdzę poprawną ścieżkę.")])[0].kind).toBe(
			"activity",
		)
	})
	it("keeps failed API request recovery accessible even when the failed ask is filtered upstream", () => {
		expect(buildAgentFeed([say(1, "api_req_started")], 2, true)[0].kind).toBe("message")
	})
	it("preserves questions, completion, user feedback, images and unknown interactive content", () => {
		const messages = [
			ask(1, "followup"),
			ask(2, "completion_result"),
			say(3, "user_feedback"),
			say(4, "image"),
			ask(5, "mistake_limit_reached"),
		]
		expect(buildAgentFeed(messages).every((item) => item.kind === "message")).toBe(true)
	})
	it("does not revive stale decisions after work has resumed", () => {
		const feed = buildAgentFeed([
			ask(1, "tool", { approvalState: "USER_DECISION_REQUIRED" }),
			say(2, "api_req_started"),
		])
		expect(feed).toHaveLength(1)
		expect(feed[0].kind).toBe("activity")
	})
	it("retains a stable activity identity as streaming messages are appended", () => {
		const first = say(1, "api_req_started")
		expect(buildAgentFeed([first])[0].ts).toBe(buildAgentFeed([first, say(2, "reasoning")])[0].ts)
	})
	it("labels the observed operation without claiming tests or edits succeeded", () => {
		expect(getAgentActivityLabel([ask(1, "command", { text: "pnpm test" })])).toBe("Working in terminal")
		expect(getAgentActivityLabel([ask(2, "tool", { text: JSON.stringify({ tool: "readFile" }) })])).toBe(
			"Browsing project files",
		)
		expect(getAgentActivityLabel([ask(3, "tool", { text: JSON.stringify({ tool: "appliedDiff" }) })])).toBe(
			"Applying changes to project",
		)
		expect(getAgentActivityLabel([say(4, "reasoning", "secret reasoning")])).toBe("Working on task")
	})
})
