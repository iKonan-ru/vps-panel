package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/transport"
)

// stream - вывод операции по мере выполнения (stdout, stderr, log, data).
type stream = func(channel, chunk string)

// op - операция агента: разбор параметров и выполнение.
type op func(ctx context.Context, params json.RawMessage, out stream) (any, error)

// typed - операция с параметрами P. Кривые параметры - ошибка до выполнения (decode).
func typed[P any](fn func(ctx context.Context, p P, out stream) (any, error)) op {
	return func(ctx context.Context, raw json.RawMessage, out stream) (any, error) {
		var p P
		if err := decode(raw, &p); err != nil {
			return nil, err
		}
		return fn(ctx, p, out)
	}
}

// plain - операция без параметров.
func plain(fn func(ctx context.Context, out stream) (any, error)) op {
	return func(ctx context.Context, _ json.RawMessage, out stream) (any, error) {
		return fn(ctx, out)
	}
}

// done - ответ {"ok": true} операции, которой нечего вернуть.
func done(err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// decode - параметры операции. Кривые - ошибка, а не нулевые значения: пустой список шагов
// baseline.apply, например, значит "все нужные шаги", включая отключение входа по паролю.
func decode(params json.RawMessage, v any) error {
	if len(params) == 0 {
		return nil
	}
	if err := json.Unmarshal(params, v); err != nil {
		return fmt.Errorf("неверные параметры: %w", err)
	}
	return nil
}

// registry - все операции агента по доменам. Список имён уходит панели в hello, тест сверяет
// его с AgentMethodSchema в packages/protocol.
func registry(panelURL string) map[string]op {
	all := map[string]op{}
	for _, part := range []map[string]op{systemOps(panelURL), serviceOps(), taskOps(panelURL)} {
		for name, o := range part {
			if _, dup := all[name]; dup {
				panic("операция объявлена дважды: " + name)
			}
			all[name] = o
		}
	}
	return all
}

// methods - имена операций для hello, по алфавиту.
func methods(ops map[string]op) []string {
	return slices.Sorted(maps.Keys(ops))
}

// handler отвечает на запросы панели.
func handler(ops map[string]op) transport.Handler {
	return func(ctx context.Context, method string, params json.RawMessage, out func(channel, chunk string)) (any, error) {
		o, ok := ops[method]
		if !ok {
			return nil, errors.New("метод пока не поддерживается: " + method)
		}
		return o(ctx, params, out)
	}
}
