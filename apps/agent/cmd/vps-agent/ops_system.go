package main

import (
	"context"
	"errors"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/audit"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/baseline"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/cleanup"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/inventory"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/selfupdate"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// systemOps - сам сервер: снимок, чистка диска, эталон, firewall, ключи SSH, пакеты,
// перезагрузка, обновление агента.
func systemOps(panelURL string) map[string]op {
	return map[string]op{
		"inventory.get": plain(func(ctx context.Context, _ stream) (any, error) {
			return inventory.Collect(ctx, Version), nil
		}),
		"disk.cleanup.scan": plain(func(ctx context.Context, _ stream) (any, error) {
			items, err := cleanup.Scan(ctx)
			if err != nil {
				return nil, err
			}
			return map[string]any{"items": items}, nil
		}),
		"disk.cleanup.run": typed(func(ctx context.Context, p struct {
			IDs []string `json:"ids"`
		}, out stream) (any, error) {
			return cleanup.Run(ctx, p.IDs, out)
		}),

		"baseline.plan": plain(func(ctx context.Context, _ stream) (any, error) {
			return baseline.MakePlan(ctx), nil
		}),
		"baseline.apply": typed(func(ctx context.Context, p struct {
			Steps []string `json:"steps"`
		}, out stream) (any, error) {
			err := baseline.Apply(ctx, p.Steps, out)
			audit.InvalidateUpdates()
			return done(err)
		}),

		"firewall.rules.set": typed(func(ctx context.Context, p struct {
			Rules []baseline.ManualRule `json:"rules"`
		}, _ stream) (any, error) {
			return done(baseline.SetManualRules(ctx, p.Rules))
		}),
		"firewall.portsync.config": typed(func(ctx context.Context, p struct {
			Config *baseline.PortsyncConfig `json:"config"`
		}, _ stream) (any, error) {
			if p.Config == nil {
				return baseline.ReadPortsyncConfig(), nil
			}
			if err := baseline.WritePortsyncConfig(*p.Config); err != nil {
				return nil, err
			}
			return portsync(ctx)
		}),
		"firewall.portsync.run": plain(func(ctx context.Context, _ stream) (any, error) {
			return portsync(ctx)
		}),
		"firewall.enable": plain(func(ctx context.Context, out stream) (any, error) {
			return done(baseline.EnableFirewall(ctx, out))
		}),
		"firewall.disable": typed(func(ctx context.Context, p struct {
			RestartDocker bool `json:"restartDocker"`
		}, out stream) (any, error) {
			return done(baseline.DisableFirewall(ctx, p.RestartDocker, out))
		}),

		"ssh.keys.add": typed(func(_ context.Context, p struct {
			Keys []string `json:"keys"`
		}, _ stream) (any, error) {
			if len(p.Keys) == 0 {
				return nil, errors.New("нужен список keys")
			}
			n, err := baseline.AddRootKeys(p.Keys)
			if err != nil {
				return nil, err
			}
			return map[string]any{"added": n}, nil
		}),
		"ssh.keys.list": plain(func(ctx context.Context, _ stream) (any, error) {
			return baseline.ListRootKeys(ctx)
		}),
		"ssh.keys.remove": typed(func(ctx context.Context, p sshKeyParams, _ stream) (any, error) {
			return done(baseline.RemoveRootKey(ctx, p.Fingerprint))
		}),
		"ssh.keys.comment": typed(func(_ context.Context, p sshKeyParams, _ stream) (any, error) {
			return done(baseline.SetRootKeyComment(p.Fingerprint, p.Comment))
		}),

		// частота метрик: панель ускоряет, пока открыта её вкладка, и замедляет, когда никто не смотрит
		"metrics.interval": typed(func(_ context.Context, p struct {
			Sec int `json:"sec"`
		}, _ stream) (any, error) {
			if p.Sec < 2 || p.Sec > 300 {
				return nil, errors.New("частота метрик - от 2 до 300 секунд")
			}
			setMetricsEvery(time.Duration(p.Sec) * time.Second)
			return done(nil)
		}),

		"system.upgrade": plain(func(ctx context.Context, out stream) (any, error) {
			err := baseline.Upgrade(ctx, out)
			audit.InvalidateUpdates()
			return done(err)
		}),
		"system.reboot": plain(func(context.Context, stream) (any, error) {
			go func() {
				time.Sleep(2 * time.Second)
				_ = shell.OK(context.Background(), "systemctl", "reboot")
			}()
			return done(nil)
		}),

		"agent.update": typed(func(ctx context.Context, p struct {
			// sha256 по архитектурам (linux-amd64, linux-arm64)
			Sha256 map[string]string `json:"sha256"`
		}, out stream) (any, error) {
			sum, err := selfupdate.Run(ctx, panelURL, p.Sha256, func(line string) { out("log", line+"\n") })
			if errors.Is(err, selfupdate.ErrUpToDate) {
				return map[string]any{"ok": true, "sha256": sum, "restarting": false, "message": "уже последняя версия"}, nil
			}
			if err != nil {
				return nil, err
			}
			return map[string]any{"ok": true, "sha256": sum, "restarting": true}, nil
		}),
		"agent.update.cancel": plain(func(context.Context, stream) (any, error) {
			return map[string]any{"cancelled": selfupdate.Cancel()}, nil
		}),
	}
}

type sshKeyParams struct {
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment"`
}

func portsync(ctx context.Context) (any, error) {
	out, err := baseline.RunPortsync(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "output": out}, nil
}
