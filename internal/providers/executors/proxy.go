package executors

import (
	"net"
	"net/http"
	"time"
)

// sharedTransport is a tuned http.Transport for upstream LLM providers.
// It enables HTTP/2, reuses TLS handshakes, and keeps a generous idle pool
// so concurrent streaming requests don't pay connection setup per request.
var sharedTransport = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	DialContext: (&net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	ForceAttemptHTTP2:     true,
	MaxIdleConns:          256,
	MaxIdleConnsPerHost:   64,
	MaxConnsPerHost:       128,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
}

// sharedClient is the reusable upstream HTTP client. Using one client (rather
// than creating a new one per request) lets the transport reuse idle
// connections and amortize TLS handshakes across requests.
var sharedClient = &http.Client{
	Transport: sharedTransport,
}

// ProxyTransport returns the shared upstream transport. Kept for callers that
// need to inspect or wrap it; BaseExecutor uses sharedClient directly.
func ProxyTransport() *http.Transport {
	return sharedTransport
}
