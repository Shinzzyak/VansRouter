package executors

import "net/http"

// ProxyTransport returns an http.Transport that honors HTTP_PROXY,
// HTTPS_PROXY, and NO_PROXY environment variables via the stdlib proxy
// resolver.
func ProxyTransport() *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
	}
}
