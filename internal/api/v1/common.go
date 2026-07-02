package v1

import (
	"net/http"
)

func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

func getString(m map[string]any, key string, fallback ...string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}
