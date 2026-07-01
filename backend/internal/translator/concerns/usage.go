package concerns

// ponytail: usage merging with provider-specific counters deferred.
func MergeUsage(dst, src map[string]any) map[string]any {
	if dst == nil {
		dst = map[string]any{}
	}
	for k, v := range src {
		dst[k] = v
	}
	return dst
}
