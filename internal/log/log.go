package log

import (
	"fmt"
	"log/slog"
	"os"
	"runtime/debug"
	"strings"
)

// Stack returns the current goroutine's stack trace as a string. Used
// by the HTTP recovery middleware to log panic origin.
func Stack() string { return string(debug.Stack()) }

// New creates a JSON slog.Logger at the requested level.
// Valid levels are: debug, info, warn, error.
func New(level string) (*slog.Logger, error) {
	var sl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		sl = slog.LevelDebug
	case "info":
		sl = slog.LevelInfo
	case "warn", "warning":
		sl = slog.LevelWarn
	case "error":
		sl = slog.LevelError
	default:
		return nil, fmt.Errorf("invalid log level %q", level)
	}

	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: sl})
	return slog.New(handler), nil
}
