package transport

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
)

// Паника в обработчике - ошибка операции, а не падение агента.
func TestCallRecoversPanic(t *testing.T) {
	c := &Client{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	c.handler = func(context.Context, string, json.RawMessage, func(string, string)) (any, error) {
		var s []string
		return s[0], nil
	}
	_, err := c.call(context.Background(), request{ID: "1", Method: "x.y"}, nil)
	if err == nil || !strings.Contains(err.Error(), "x.y") {
		t.Fatalf("ожидалась ошибка с названием операции, получено %v", err)
	}
}
