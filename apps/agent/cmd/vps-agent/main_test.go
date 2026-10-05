package main

import (
	"encoding/json"
	"testing"
)

func TestDecode(t *testing.T) {
	var p struct {
		Steps []string `json:"steps"`
	}
	if err := decode(json.RawMessage(`{"steps":"ufw"}`), &p); err == nil {
		t.Fatal("кривые параметры прошли без ошибки (пустой список шагов = все шаги)")
	}
	if err := decode(nil, &p); err != nil {
		t.Fatalf("пустые параметры: %v", err)
	}
	if err := decode(json.RawMessage(`{"steps":["ufw"]}`), &p); err != nil || len(p.Steps) != 1 {
		t.Fatalf("верные параметры: %v %v", err, p.Steps)
	}
}
