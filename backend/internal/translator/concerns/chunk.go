package concerns

// ponytail: real chunk-splitting / buffering logic deferred.
func SplitChunk(format string, chunk map[string]any) []map[string]any {
	return []map[string]any{chunk}
}
