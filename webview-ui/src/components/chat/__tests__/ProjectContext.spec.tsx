import { describe, it, expect } from "vitest"
import { getContextPaths, toggleContextPath } from "../ProjectContext"

describe("explicit project context", () => {
	it("preserves indentation and blank lines in the draft when removing a file", () => {
		const draft = "\n```py\n    if value:\n        run()\n```\n"
		expect(toggleContextPath(toggleContextPath(draft, "app.py"), "app.py")).toBe(draft)
	})
	it("round trips paths with spaces without removing prose or other mention types", () => {
		const draft = "Sprawdź @problems i opisz wynik.\n"
		const added = toggleContextPath(draft, "src/Mój plik.ts")
		expect(getContextPaths(added)).toEqual(["src/Mój plik.ts"])
		expect(toggleContextPath(added, "src/Mój plik.ts")).toBe(draft)
	})
	it("deduplicates existing context and removes only the selected path", () => {
		const draft = "Zbadaj @/src/a.ts @/src/a.ts @/src/b.ts"
		expect(getContextPaths(draft)).toEqual(["src/a.ts", "src/b.ts"])
		expect(getContextPaths(toggleContextPath(draft, "src/a.ts"))).toEqual(["src/b.ts"])
		expect(toggleContextPath(draft, "src/a.ts")).toContain("Zbadaj")
	})
})
