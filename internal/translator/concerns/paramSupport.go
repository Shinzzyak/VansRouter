package concerns

// ponytail: provider-specific unsupported-parameter filtering deferred.
func FilterUnsupportedParams(body map[string]any, supported map[string]bool) map[string]any {
	return body
}
