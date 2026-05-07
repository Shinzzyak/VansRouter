import { extractUsage } from "./open-sse/utils/usageTracking.js";

const chunk1 = {"id":"gen-17381", "object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}
const chunk2 = {"id":"gen-17381", "object":"chat.completion.chunk","choices":[{"delta":{}, "finish_reason":"stop"}], "usage": {"prompt_tokens": 12, "completion_tokens": 5}}

console.log(extractUsage(chunk1));
console.log(extractUsage(chunk2));
