import { getSharedToolUseSection } from "../tool-use"

describe("getSharedToolUseSection", () => {
	it("requests meaningful factual updates while leaving technical narration in the activity log", () => {
		const section = getSharedToolUseSection()
		expect(section).toContain("brief, natural updates in their language")
		expect(section).toContain("Do not narrate every tool call")
		expect(section).toContain("starting a test is not evidence that it passed")
	})
	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Do not include XML markup or examples")
	})

	it("should include multiple tools per message guidance", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("You must call at least one tool per assistant response")
		expect(section).toContain("Prefer calling as many tools as are reasonably needed")
	})

	it("should NOT include single tool per message restriction", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("You must use exactly one tool call per assistant response")
		expect(section).not.toContain("Do not call zero tools or more than one tool")
	})

	it("should NOT include XML formatting instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("<actual_tool_name>")
		expect(section).not.toContain("</actual_tool_name>")
	})
})
