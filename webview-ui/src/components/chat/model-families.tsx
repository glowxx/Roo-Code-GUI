import { SiOpenai, SiAnthropic, SiGooglegemini, SiMeta } from "react-icons/si"
import { Cpu } from "lucide-react"

// Local, monochrome marks keep the menu usable offline and in every theme.
export const modelFamilies = {
	openai: { name: "GPT", company: "OpenAI", Icon: SiOpenai, monogram: "" },
	claude: { name: "Claude", company: "Anthropic", Icon: SiAnthropic, monogram: "" },
	gemini: { name: "Gemini", company: "Google", Icon: SiGooglegemini, monogram: "" },
	qwen: { name: "Qwen", company: "Alibaba", Icon: null, monogram: "Q" },
	grok: { name: "Grok", company: "xAI", Icon: null, monogram: "x" },
	meta: { name: "Llama", company: "Meta", Icon: SiMeta, monogram: "" },
	deepseek: { name: "DeepSeek", company: "DeepSeek", Icon: null, monogram: "D" },
	mistral: { name: "Mistral", company: "Mistral AI", Icon: null, monogram: "M" },
	gemma: { name: "Gemma", company: "Google", Icon: null, monogram: "G" },
	glm: { name: "GLM", company: "Z.ai", Icon: null, monogram: "Z" },
	kimi: { name: "Kimi", company: "Moonshot AI", Icon: null, monogram: "K" },
	minimax: { name: "MiniMax", company: "MiniMax", Icon: null, monogram: "m" },
	cohere: { name: "Command", company: "Cohere", Icon: null, monogram: "C" },
	other: { name: "Other Models", company: "", Icon: Cpu, monogram: "" },
} as const

export type ModelFamily = keyof typeof modelFamilies
export const modelFamilyOrder = Object.keys(modelFamilies) as ModelFamily[]

export const extractModelFamily = (id: string): ModelFamily => {
	const lower = id.toLowerCase()
	// The publisher prefix takes precedence over base models mentioned in a distillation name.
	const vendor = lower.includes("/") ? lower.split("/")[0] : ""
	const vendors: Record<string, ModelFamily> = {
		openai: "openai",
		anthropic: "claude",
		qwen: "qwen",
		"qwen-code": "qwen",
		xai: "grok",
		"x-ai": "grok",
		meta: "meta",
		"meta-llama": "meta",
		deepseek: "deepseek",
		mistralai: "mistral",
		"z-ai": "glm",
		zai: "glm",
		moonshotai: "kimi",
		minimax: "minimax",
		cohere: "cohere",
	}
	if (vendors[vendor]) return vendors[vendor]
	if (/claude|anthropic/.test(lower)) return "claude"
	if (/gpt|(?:^|[/_-])o\d+(?:[._/-]|$)/.test(lower)) return "openai"
	if (/deepseek/.test(lower)) return "deepseek"
	if (/gemini/.test(lower)) return "gemini"
	if (/gemma/.test(lower)) return "gemma"
	if (/qwen|qwq/.test(lower)) return "qwen"
	if (/grok/.test(lower)) return "grok"
	if (/llama/.test(lower)) return "meta"
	if (/mistral|mixtral|codestral|devstral|ministral|magistral|pixtral/.test(lower)) return "mistral"
	if (/glm/.test(lower)) return "glm"
	if (/kimi|moonshot/.test(lower)) return "kimi"
	if (/minimax/.test(lower)) return "minimax"
	if (/command-r|command-a|cohere/.test(lower)) return "cohere"
	return "other"
}

export function ModelFamilyIcon({ family }: { family: ModelFamily }) {
	const { Icon, monogram, company } = modelFamilies[family]
	return (
		<span className="model-family-icon" data-family={family} aria-hidden="true" title={company || undefined}>
			{Icon ? <Icon /> : <span className="model-family-monogram">{monogram}</span>}
		</span>
	)
}

// Compare version components as integers: 5.10 follows 5.9; Sonnet 4-5 equals 4.5.
export const modelVersionParts = (id: string): number[] => {
	const name = id.split("/").pop()!.toLowerCase()
	const version = name.match(
		/(?:gpt|claude(?:-(?:sonnet|opus|haiku))?|gemini|gemma|qwen|qwq|grok|llama|deepseek|glm|kimi|command|o)(?:[-_]?v|[-_]?r|[-_]?k)?[-_]?(\d+(?:[.\-_]\d+)*)/,
	)
	return version ? version[1].split(/[.\-_]/).map(Number) : []
}
