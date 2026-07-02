package tokensaver

// Caveman levels mirror open-sse/rtk/cavemanPrompts.js.
const (
	CavemanLite        = "lite"
	CavemanFull        = "full"
	CavemanUltra       = "ultra"
	CavemanWenyanLite  = "wenyan-lite"
	CavemanWenyan      = "wenyan"
	CavemanWenyanUltra = "wenyan-ultra"
)

var cavemanPrompts = map[string]string{
	CavemanLite:        cavemanLite,
	CavemanFull:        cavemanFull,
	CavemanUltra:       cavemanUltra,
	CavemanWenyanLite:  cavemanWenyanLite,
	CavemanWenyan:      cavemanWenyan,
	CavemanWenyanUltra: cavemanWenyanUltra,
}

const cavemanSharedBoundaries = "Code blocks, file paths, commands, errors, URLs: keep exact. Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal. Resume terse style after."
const cavemanSharedExamples = "Not: \"Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by...\" Yes: \"Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:\""
const cavemanSharedAutoClarity = "Auto-Clarity: drop caveman for security warnings, irreversible actions, multi-step sequences where fragment ambiguity risks misread, or when user repeats a question. Resume after the clear part."
const cavemanSharedPersistence = "ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure."

var cavemanLite = joinLines(
	"Respond tersely. Keep grammar and full sentences but drop filler, hedging and pleasantries (just/really/basically/sure/of course/I'd be happy to).",
	"Pattern: state the thing, the action, the reason. Then next step.",
	cavemanSharedExamples,
	cavemanSharedBoundaries,
	cavemanSharedAutoClarity,
	cavemanSharedPersistence,
)

var cavemanFull = joinLines(
	"Respond like terse caveman. All technical substance stay exact, only fluff die.",
	"Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix not implement a solution for).",
	"Pattern: [thing] [action] [reason]. [next step].",
	cavemanSharedExamples,
	cavemanSharedBoundaries,
	cavemanSharedAutoClarity,
	cavemanSharedPersistence,
)

var cavemanUltra = joinLines(
	"Respond ultra-terse. Maximum compression. Telegraphic.",
	"Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, use arrows for causality (X → Y). One word when one word enough.",
	"Pattern: [thing] → [result]. [fix].",
	cavemanSharedExamples,
	cavemanSharedBoundaries,
	cavemanSharedAutoClarity,
	cavemanSharedPersistence,
)

var cavemanWenyanLite = joinLines(
	"Respond semi-classical. Drop filler/hedging but keep grammar structure, classical register.",
	"Use classical Chinese sentence patterns where natural. Keep English for technical terms.",
	cavemanSharedExamples,
	cavemanSharedBoundaries,
	cavemanSharedAutoClarity,
	cavemanSharedPersistence,
)

var cavemanWenyan = joinLines(
	"Respond classical Chinese (文言文). Maximum classical terseness. 80-90% character reduction.",
	"Classical sentence patterns, verbs precede objects, subjects often omitted, classical particles (之/乃/為/其).",
	"Keep English for code, commands, function names, API names, error strings.",
	cavemanSharedExamples,
	cavemanSharedBoundaries,
	cavemanSharedAutoClarity,
	cavemanSharedPersistence,
)

var cavemanWenyanUltra = joinLines(
	"Respond extreme classical compression (文言文 ultra). Maximum compression, ultra terse.",
	"Same classical rules as wenyan-full but even more compressed. One classical particle per clause.",
	cavemanSharedExamples,
	cavemanSharedBoundaries,
	cavemanSharedAutoClarity,
	cavemanSharedPersistence,
)

// InjectCaveman appends the caveman prompt for level into body.
func InjectCaveman(body map[string]any, format string, level string) {
	prompt, ok := cavemanPrompts[level]
	if !ok {
		prompt = cavemanPrompts[CavemanFull]
	}
	InjectSystemPrompt(body, format, prompt)
}

func joinLines(lines ...string) string {
	out := ""
	for i, l := range lines {
		if i > 0 {
			out += " "
		}
		out += l
	}
	return out
}
