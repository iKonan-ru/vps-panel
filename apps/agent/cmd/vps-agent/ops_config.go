package main

import (
	"context"
	"encoding/json"
	"os/exec"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/config"
)

// restartLater - перезапуск службы через 2 с (ответ панели уходит раньше).
var restartLater = func() error {
	cmd := exec.Command("sh", "-c", "sleep 2; systemctl restart vps-agent")
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// panelURLOp - panel.url: новый адрес панели (у панели появился домен - vps-panel domain).
// Агент верит ключу панели, а не адресу: по новому адресу он подключится, только если там та же
// панель. Адрес тот же - ничего не делает; другой - сохраняет и перезапускается.
func panelURLOp(cfg *config.Config, path string) op {
	return func(_ context.Context, params json.RawMessage, _ stream) (any, error) {
		var p struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if err := config.CheckPanelURL(p.URL); err != nil {
			return nil, err
		}
		if p.URL == cfg.PanelURL {
			return map[string]any{"changed": false}, nil
		}
		next := *cfg
		next.PanelURL = p.URL
		if err := next.Save(path); err != nil {
			return nil, err
		}
		cfg.PanelURL = p.URL
		if err := restartLater(); err != nil {
			return nil, err
		}
		return map[string]any{"changed": true}, nil
	}
}

// withConfigOps - операции над конфигом агента (им нужен сам конфиг и путь к нему).
func withConfigOps(ops map[string]op, cfg *config.Config, path string) map[string]op {
	ops["panel.url"] = panelURLOp(cfg, path)
	return ops
}
