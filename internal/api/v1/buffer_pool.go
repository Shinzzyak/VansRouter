package v1

import (
	"bytes"
	"sync"
)

// jsonBufferPool reuses bytes.Buffer values for JSON error responses.
// This avoids a small allocation per error path on hot endpoints like
// /v1/chat/completions.
var jsonBufferPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

func acquireJSONBuffer() *bytes.Buffer {
	b := jsonBufferPool.Get().(*bytes.Buffer)
	b.Reset()
	return b
}

func releaseJSONBuffer(b *bytes.Buffer) {
	if b != nil {
		b.Reset()
		jsonBufferPool.Put(b)
	}
}
