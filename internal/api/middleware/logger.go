package middleware

import (
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/9router/9router/internal/log"
)

// statusRecorder captures the response status for the access log with minimal
// overhead: one atomic int32 instead of counting every byte written.
type statusRecorder struct {
	http.ResponseWriter
	status atomic.Int32
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status.Store(int32(code))
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status.Load() == 0 {
		s.status.Store(int32(http.StatusOK))
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) statusCode() int {
	if c := s.status.Load(); c != 0 {
		return int(c)
	}
	return http.StatusOK
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
				slog.Int("status", rec.statusCode()),
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
