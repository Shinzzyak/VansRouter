package middleware

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/9router/9router/internal/log"
)

// statusRecorder captures the response status for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// RequestLogger emits one structured slog line per HTTP request. It is
// the Go equivalent of the access logs Next.js emits via stdout.
func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)

			logger.LogAttrs(r.Context(), slog.LevelInfo, "http_request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.String("query", r.URL.RawQuery),
				slog.Int("status", rec.status),
				slog.Int("bytes", rec.bytes),
				slog.String("ip", ClientIP(r)),
				slog.String("ua", r.UserAgent()),
				slog.Duration("duration", time.Since(start)),
			)
		})
	}
}

// Recovery turns panics into a 500 response while logging the panic
// value + stack. It must run inside a RequestLogger so the access log
// still records the final status (500).
func Recovery(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					logger.Error("panic_recovered",
						slog.Any("error", rec),
						slog.String("path", r.URL.Path),
						slog.String("stack", log.Stack()),
					)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{"error":{"message":"internal server error","type":"internal_error"}}`))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
