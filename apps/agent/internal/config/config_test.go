package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, text string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

const key = "Q1ZRn0Gm8i6qYv5pXlRZ2uVwL0dY1x8b0c2Vt0e3N1c="

func TestLoadNeedsPanelKey(t *testing.T) {
	if _, err := Load(writeConfig(t, `{"panelUrl":"https://panel.example.com","token":"t"}`)); err == nil || !strings.Contains(err.Error(), "panelKey") {
		t.Fatalf("конфиг без ключа панели должен отклоняться, получено %v", err)
	}
	if _, err := Load(writeConfig(t, `{"panelUrl":"https://panel.example.com","panelKey":"short","token":"t"}`)); err == nil {
		t.Fatal("неверный ключ панели принят")
	}
	c, err := Load(writeConfig(t, `{"panelUrl":"https://panel.example.com","panelKey":"`+key+`","token":"t"}`))
	if err != nil {
		t.Fatal(err)
	}
	if k, err := c.Key(); err != nil || len(k) != 32 {
		t.Fatalf("ключ: %v %v", k, err)
	}
}
