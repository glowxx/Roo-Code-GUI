import type { ClineMessage } from "@roo-code/types"

export type AgentFeedItem =
	| { kind: "message"; ts: number; message: ClineMessage }
	| { kind: "activity"; ts: number; messages: ClineMessage[] }

const conversationTypes = new Set([
	"text",
	"completion_result",
	"user_feedback",
	"user_feedback_diff",
	"followup",
	"subtask_result",
])
const technicalTypes = new Set([
	"tool",
	"command",
	"command_output",
	"use_mcp_server",
	"reasoning",
	"api_req_started",
	"api_req_finished",
	"api_req_retried",
	"api_req_deleted",
	"api_req_retry_delayed",
	"api_req_rate_limit_wait",
	"checkpoint_saved",
	"condense_context",
	"condense_context_error",
	"sliding_window_truncation",
	"codebase_search_result",
	"mcp_server_request_started",
	"mcp_server_response",
	"command_safety_warning",
	"error",
	"diff_error",
	"rooignore_error",
	"shell_integration_warning",
	"too_many_tools_warning",
	"user_edit_todos",
])

/** A view of the original log, never a replacement for the approval or execution state. */
export function buildAgentFeed(
	messages: ClineMessage[],
	pendingAskTs?: number,
	apiRequestFailed = false,
): AgentFeedItem[] {
	const feed: AgentFeedItem[] = []
	const lastAskIndex = messages.findLastIndex((message) => message.type === "ask")
	for (const [index, message] of messages.entries()) {
		const type = message.type === "ask" ? message.ask : message.say
		const isLastAsk = index === lastAskIndex
		const hasResumedWork = messages
			.slice(index + 1)
			.some(
				(next) =>
					next.say !== "command_safety_warning" &&
					next.say !== "api_req_retry_delayed" &&
					next.say !== "api_req_rate_limit_wait",
			)
		const requiresDecision =
			message.type === "ask" &&
			!message.isAnswered &&
			!["AUTO_APPROVED", "EVALUATING", "DENIED"].includes(message.approvalState || "") &&
			(message.ts === pendingAskTs || (isLastAsk && !hasResumedWork))
		const unresolvedProblem =
			index === messages.length - 1 &&
			(type === "error" ||
				type === "diff_error" ||
				type === "command_safety_warning" ||
				type === "condense_context_error" ||
				type === "rooignore_error" ||
				type === "shell_integration_warning")
		let interruptedResponse = false
		if (type === "api_req_started" && index === messages.length - 1) {
			try {
				const request = JSON.parse(message.text || "{}")
				interruptedResponse = !!request.streamingFailedMessage || request.cancelReason === "streaming_failed"
			} catch {
				/* A partial request payload does not establish an error. */
			}
		}
		if (
			!type ||
			conversationTypes.has(type) ||
			requiresDecision ||
			unresolvedProblem ||
			interruptedResponse ||
			(apiRequestFailed && index === messages.length - 1 && type === "api_req_started") ||
			!technicalTypes.has(type)
		) {
			feed.push({ kind: "message", ts: message.ts, message })
		} else {
			const previous = feed.at(-1)
			if (previous?.kind === "activity") previous.messages.push(message)
			else feed.push({ kind: "activity", ts: message.ts, messages: [message] })
		}
	}
	return feed
}

/** Describe only the observed action, without inventing findings or a successful result. */
export function getAgentActivityLabel(
	messages: ClineMessage[],
	t?: (key: string, defaultValue?: string) => string,
): string {
	const translate = (key: string, fallback: string) => (t ? t(key, fallback) : fallback)
	const latest = messages.at(-1)
	if (latest?.say === "api_req_rate_limit_wait") {
		return translate("chat:agentActivity.rateLimitWait", "Waiting for model availability")
	}
	if (latest?.say === "api_req_retry_delayed") {
		return translate("chat:agentActivity.retryDelayed", "Waiting to retry request")
	}
	if (latest?.say === "api_req_started" || latest?.say === "reasoning") {
		return translate("chat:agentActivity.working", "Working on task")
	}
	for (const message of [...messages].reverse()) {
		if (message.ask === "command" || message.say === "command_output") {
			return translate("chat:agentActivity.terminal", "Working in terminal")
		}
		if (message.ask === "use_mcp_server") {
			return translate("chat:agentActivity.mcpTools", "Using project tools")
		}
		if (message.say === "condense_context" && message.partial) {
			return translate("chat:agentActivity.condenseContext", "Organizing conversation context")
		}
		if (message.ask !== "tool" && message.say !== ("tool" as any)) continue
		try {
			const tool = JSON.parse(message.text || "{}")
			if (/edit|diff|newFile|insert|replace/i.test(tool.tool)) {
				return translate("chat:agentActivity.editingFiles", "Applying changes to project")
			}
			if (/read|list|search/i.test(tool.tool)) {
				return translate("chat:agentActivity.readingFiles", "Browsing project files")
			}
		} catch {
			/* An incomplete streamed tool payload is not a user-facing finding. */
		}
	}
	return translate("chat:agentActivity.working", "Working on task")
}
