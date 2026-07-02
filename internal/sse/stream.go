// Package sse provides server-sent event primitives: a stream controller
// that bridges client disconnect / context cancellation to upstream aborts,
// and a chunked pipe that drives the SSE response body.
package sse

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultStallTimeoutMs is the default upstream inactivity watchdog used by
// the streaming chat handler. Mirrors STREAM_STALL_TIMEOUT_MS in
// open-sse/config/runtimeConfig.js.
const DefaultStallTimeoutMs = 30_000

// AbortDelayMs is how long after a client disconnect we wait before aborting
// the upstream fetch — gives the handler a brief grace period to flush
// bookkeeping. Mirrors the 500ms in open-sse/utils/streamHandler.js.
const AbortDelayMs = 500

// StreamController wires a client request's lifecycle to an upstream fetch.
// All exported methods are safe to call from multiple goroutines.
type StreamController struct {
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	startNs atomic.Int64

	disconnected atomic.Bool
	completed    atomic.Bool
	errored      atomic.Bool

	mu     sync.Mutex
	onDisc []func(reason string)
}

// NewStreamController returns a controller tied to reqCtx. When the request
// context is canceled (client disconnect), the upstream is aborted after
// AbortDelayMs so in-flight bookkeeping can finish.
func NewStreamController(reqCtx context.Context) *StreamController {
	ctx, cancel := context.WithCancel(reqCtx)
	sc := &StreamController{
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	sc.startNs.Store(time.Now().UnixNano())
	go func() {
		<-ctx.Done()
		close(sc.done)
	}()
	return sc
}

// Context exposes the controller's context. Upstream fetches should derive
// their request context from this so client cancellation propagates.
func (sc *StreamController) Context() context.Context { return sc.ctx }

// OnDisconnect registers a callback fired when the client disconnects or
// the request context is canceled. Safe to call multiple times.
func (sc *StreamController) OnDisconnect(fn func(reason string)) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.onDisc = append(sc.onDisc, fn)
}

// HandleDisconnect marks the stream as disconnected and aborts the upstream
// after AbortDelayMs. Idempotent.
func (sc *StreamController) HandleDisconnect(reason string) {
	if !sc.disconnected.CompareAndSwap(false, true) {
		return
	}
	sc.mu.Lock()
	fns := sc.onDisc
	sc.onDisc = nil
	sc.mu.Unlock()
	for _, fn := range fns {
		fn(reason)
	}
	time.AfterFunc(AbortDelayMs, sc.cancel)
}

// HandleComplete marks the stream as cleanly completed. Idempotent.
func (sc *StreamController) HandleComplete() {
	if !sc.completed.CompareAndSwap(false, true) {
		return
	}
	sc.cancel()
}

// HandleError marks the stream as errored and cancels the upstream.
// Idempotent. Errors with a context.Canceled / "aborted" cause are treated
// as graceful disconnects rather than fatal errors.
func (sc *StreamController) HandleError(err error) {
	if err == nil {
		return
	}
	if errors.Is(err, context.Canceled) || isAbortError(err) {
		sc.HandleDisconnect("aborted")
		return
	}
	if !sc.errored.CompareAndSwap(false, true) {
		return
	}
	sc.cancel()
}

// Abort immediately cancels the upstream fetch.
func (sc *StreamController) Abort() { sc.cancel() }

// IsConnected reports whether the client is still attached.
func (sc *StreamController) IsConnected() bool { return !sc.disconnected.Load() }

// Done returns a channel closed when the controller terminates for any reason.
func (sc *StreamController) Done() <-chan struct{} { return sc.done }

// PipeResult describes how Pipe completed. Exactly one of Err or Reason is
// non-nil / non-empty. Reason is "complete", "disconnect:<reason>", or
// "stall".
type PipeResult struct {
	Bytes  int64
	Chunks int
	Reason string
	Err    error
}

// PipeUpstream reads from src, copies each chunk to dst, and watches for
// upstream inactivity. If no bytes arrive within stallTimeout, it aborts
// the stream controller and returns Reason="stall". Cancellation of
// streamCtx aborts the read immediately.
//
// Unlike the Node implementation, we don't wrap the body in a separate
// TransformStream — bufio.Scanner / direct io.Copy is sufficient for the
// line-buffered SSE consumer downstream.
func PipeUpstream(dst io.Writer, src io.Reader, ctrl *StreamController, stallTimeout time.Duration) PipeResult {
	res := PipeResult{}
	if stallTimeout <= 0 {
		stallTimeout = DefaultStallTimeoutMs * time.Millisecond
	}
	timer := time.NewTimer(stallTimeout)
	defer timer.Stop()

	buf := make([]byte, 16*1024)
	for {
		// Honor cancellation between reads.
		select {
		case <-ctrl.Context().Done():
			res.Reason = "disconnect:" + disconnectReason(ctrl)
			return res
		default:
		}

		// Read with a deadline derived from the stall timer.
		type readResult struct {
			n   int
			err error
		}
		readCh := make(chan readResult, 1)
		go func() {
			n, err := src.Read(buf)
			readCh <- readResult{n: n, err: err}
		}()

		select {
		case rr := <-readCh:
			if rr.n > 0 {
				if _, err := dst.Write(buf[:rr.n]); err != nil {
					res.Err = err
					return res
				}
				res.Bytes += int64(rr.n)
				res.Chunks++
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(stallTimeout)
			}
			if rr.err != nil {
				if errors.Is(rr.err, io.EOF) {
					res.Reason = "complete"
					return res
				}
				res.Err = rr.err
				return res
			}
		case <-timer.C:
			res.Reason = "stall"
			ctrl.HandleError(errors.New("stream stall timeout"))
			return res
		case <-ctrl.Context().Done():
			res.Reason = "disconnect:" + disconnectReason(ctrl)
			return res
		}
	}
}

// disconnectReason inspects the controller to label the PipeResult reason
// field. Kept as a helper so the inline string concat in PipeUpstream stays
// short.
func disconnectReason(ctrl *StreamController) string {
	if ctrl == nil {
		return "cancelled"
	}
	if ctrl.disconnected.Load() {
		return "client_closed"
	}
	return "cancelled"
}

// isAbortError reports whether err looks like a transport-level abort that
// should be treated as a graceful client disconnect rather than a failure.
func isAbortError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, needle := range []string{
		"aborted",
		"socket hang up",
		"connection reset",
		"broken pipe",
		"use of closed network connection",
	} {
		if containsFold(msg, needle) {
			return true
		}
	}
	return false
}

func containsFold(s, sub string) bool {
	if len(sub) == 0 {
		return true
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		match := true
		for j := 0; j < len(sub); j++ {
			a := s[i+j]
			b := sub[j]
			if a >= 'A' && a <= 'Z' {
				a += 'a' - 'A'
			}
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
