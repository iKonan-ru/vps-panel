package main

import (
	"context"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/backup"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/command"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/metrics"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/terminal"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/tunnel"
)

// inlineOps - операции, которые транспорт выполняет в порядке прихода (запись в туннель).
var inlineOps = map[string]bool{"tunnel.write": true}

// panelPort - порт панели сервиса на этом сервере: веб-панель 3X-UI или панель MTProxyL.
// Туннель ходит только к ним (на любом адресе, в том числе 127.0.0.1).
func panelPort(ctx context.Context, port int) bool {
	if info, err := services.ReadXui(ctx, nil); err == nil && info != nil && info.PanelPort == port {
		return true
	}
	for _, l := range firewall.PortsOf(ctx, "mtproxyl-panel") {
		if l == port {
			return true
		}
	}
	return false
}

// taskOps - работа по запросу: веб-терминал, бэкапы, сертификаты, команды каталога.
func taskOps(panelURL string) map[string]op {
	return map[string]op{
		"term.open": typed(func(ctx context.Context, p terminal.OpenParams, out stream) (any, error) {
			return terminal.Open(ctx, p, out)
		}),
		"term.input": typed(func(_ context.Context, p struct {
			ID   string `json:"id"`
			Data string `json:"data"`
		}, _ stream) (any, error) {
			return done(terminal.Input(p.ID, p.Data))
		}),
		"term.resize": typed(func(_ context.Context, p struct {
			ID   string `json:"id"`
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}, _ stream) (any, error) {
			return done(terminal.Resize(p.ID, p.Cols, p.Rows))
		}),
		"term.close": typed(func(_ context.Context, p struct {
			ID string `json:"id"`
		}, _ stream) (any, error) {
			return map[string]any{"closed": terminal.Close(p.ID)}, nil
		}),

		// поток к панели сервиса на 127.0.0.1 (поддомены панелей)
		"tunnel.open": typed(func(ctx context.Context, p tunnel.OpenParams, out stream) (any, error) {
			return tunnel.Open(ctx, p, panelPort, out)
		}),
		"tunnel.write": typed(func(_ context.Context, p struct {
			ID   string `json:"id"`
			Data string `json:"data"`
		}, _ stream) (any, error) {
			return done(tunnel.Write(p.ID, p.Data))
		}),
		"tunnel.close": typed(func(_ context.Context, p struct {
			ID string `json:"id"`
		}, _ stream) (any, error) {
			return map[string]any{"closed": tunnel.Close(p.ID)}, nil
		}),

		"backup.detect": plain(func(ctx context.Context, _ stream) (any, error) {
			return backup.Detect(ctx), nil
		}),
		"backup.create": typed(func(ctx context.Context, p backup.CreateParams, out stream) (any, error) {
			if p.UploadURL != "" {
				if err := backup.CheckPanelURL(p.UploadURL, panelURL); err != nil {
					return nil, err
				}
			}
			p.Hostname = metrics.Host(Version).Hostname
			p.Agent = Version
			return backup.Create(ctx, p, out)
		}),
		"backup.restore": typed(func(ctx context.Context, p backup.RestoreParams, out stream) (any, error) {
			if err := backup.CheckPanelURL(p.DownloadURL, panelURL); err != nil {
				return nil, err
			}
			return done(backup.Restore(ctx, p, out))
		}),

		"command.run": typed(func(ctx context.Context, p command.Params, out stream) (any, error) {
			return command.Run(ctx, p, out)
		}),
		"command.cancel": typed(func(_ context.Context, p struct {
			RunID string `json:"runId"`
		}, _ stream) (any, error) {
			return map[string]any{"cancelled": command.Cancel(p.RunID)}, nil
		}),
	}
}
