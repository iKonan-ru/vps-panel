// vps-agent: агент панели. Подключается к панели, шлёт метрики, выполняет запросы.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/adapters"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/baseline"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/config"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/inventory"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/metrics"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/terminal"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/transport"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/tunnel"
)

// Version подставляется при сборке: -ldflags "-X main.Version=0.1.0".
var Version = "dev"

// slowMetrics - частота метрик, пока на панели никто не смотрит (и до её команды).
const slowMetrics = 30 * time.Second

// metricsEvery - новая частота отправки метрик: панель ускоряет её, пока открыта её вкладка
// (операция metrics.interval).
var metricsEvery = make(chan time.Duration, 1)

// setMetricsEvery передаёт частоту циклу отправки; прежнее непрочитанное значение заменяется.
func setMetricsEvery(d time.Duration) {
	select {
	case <-metricsEvery:
	default:
	}
	metricsEvery <- d
}

func main() {
	cfgPath := flag.String("config", config.DefaultPath, "путь к конфигу")
	showVersion := flag.Bool("version", false, "показать версию")
	dumpInventory := flag.Bool("inventory", false, "собрать снимок и напечатать JSON (без подключения к панели)")
	naiveRender := flag.Bool("naive-render", false, "собрать /etc/vps-naive/Caddyfile из config.json и users.json (команда установки прокси для браузера; externalCert - сертификат от Caddy панели)")
	flag.Parse()
	if *naiveRender {
		if err := adapters.NaiveRenderFiles(); err != nil {
			fmt.Fprintln(os.Stderr, "vps-agent:", err)
			os.Exit(1)
		}
		fmt.Println("vps-agent: Caddyfile прокси для браузера собран")
		return
	}
	if *showVersion {
		fmt.Println(Version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if *dumpInventory {
		inv := inventory.Collect(context.Background(), Version)
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(inv)
		return
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	token := cfg.Token
	if token == "" {
		token = "reg:" + cfg.RegistrationToken
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// port-sync - наш скрипт: при обновлении агента подтягиваем и его, чтобы правки
	// (например, чтение 3x-ui из PostgreSQL) не ждали повторного "Привести к эталону"
	if updated, err := baseline.RefreshPortsyncScript(); err != nil {
		log.Warn("port-sync: не удалось обновить скрипт", "err", err)
	} else if updated {
		log.Info("port-sync: скрипт обновлён до версии агента")
	}

	collector := metrics.NewCollector()
	ops := registry(cfg.PanelURL)
	panelKey, _ := cfg.Key() // формат проверен в config.Load
	var client *transport.Client
	client = transport.New(cfg.PanelURL, token, panelKey, metrics.Host(Version), handler(ops), log)
	client.Methods = methods(ops)
	client.Inline = inlineOps
	client.OnPanelKey = func(key ed25519.PublicKey) {
		// старый агент без ключа: панель доказала знание токена - запоминаем её ключ
		cfg.PanelKey = base64.StdEncoding.EncodeToString(key)
		if err := cfg.Save(*cfgPath); err != nil {
			log.Error("save config", "err", err)
		} else {
			log.Info("ключ панели запомнен")
		}
	}
	client.OnDisconnect = func() {
		terminal.CloseAll()
		tunnel.CloseAll()
		// связи нет - и смотреть некому; после переподключения панель скажет частоту сама
		setMetricsEvery(slowMetrics)
	}
	client.OnWelcome = func(serverID, protocol, issued string) {
		log.Info("welcome", "serverId", serverID, "protocol", protocol)
		changed := false
		if cfg.ServerID != serverID {
			cfg.ServerID = serverID
			changed = true
		}
		if issued != "" {
			// Регистрация прошла: сохраняем постоянный токен (его создал агент), забываем одноразовый.
			cfg.Token, cfg.RegistrationToken = issued, ""
			client.SetToken(issued)
			changed = true
		}
		if changed {
			if err := cfg.Save(*cfgPath); err != nil {
				log.Error("save config", "err", err)
			}
		}
		// Первый снимок сразу после подключения.
		go func() {
			_ = client.Send(map[string]any{"type": "inventory", "inventory": inventory.Collect(ctx, Version)})
		}()
	}

	go func() {
		hb := time.NewTicker(10 * time.Second)
		mt := time.NewTicker(slowMetrics)
		inv := time.NewTicker(5 * time.Minute)
		// сервисы (xray 3X-UI, MTProxyL, контейнеры AWG и wg-easy, WDTT, WireGuard): упал или
		// поднялся - снимок сразу, не ждать 5 минут (аудит и уведомление)
		hw := time.NewTicker(30 * time.Second)
		defer hw.Stop()
		// проверка - в своей горутине: подвисшая команда не задерживает heartbeat; сравнение - с
		// состоянием последнего отправленного снимка (services.Reported), кто бы его ни запросил
		checking := false
		healthCh := make(chan string, 1)
		defer hb.Stop()
		defer mt.Stop()
		defer inv.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-hb.C:
				_ = client.Send(map[string]any{"type": "heartbeat", "ts": time.Now().UTC().Format(time.RFC3339)})
			case d := <-metricsEvery:
				mt.Reset(d)
				// ускорили - свежий замер сразу, не ждать прежнего тика
				if m, err := collector.Collect(ctx); err == nil {
					_ = client.Send(map[string]any{"type": "metrics", "metrics": m})
				}
			case <-mt.C:
				if m, err := collector.Collect(ctx); err == nil {
					_ = client.Send(map[string]any{"type": "metrics", "metrics": m})
				}
			case <-inv.C:
				_ = client.Send(map[string]any{"type": "inventory", "inventory": inventory.Collect(ctx, Version)})
			case <-hw.C:
				if checking {
					continue
				}
				checking = true
				go func() {
					var cs []proto.Container
					if dockerapi.Available() {
						cs, _ = dockerapi.New().List(ctx)
					}
					healthCh <- services.Health(ctx, cs)
				}()
			case h := <-healthCh:
				checking = false
				if h != services.Reported() {
					log.Info("сервисы: состояние сменилось", "down", h)
					// до прихода нового снимка не слать его повторно
					services.MarkReported(h)
					go func() {
						_ = client.Send(map[string]any{"type": "inventory", "inventory": inventory.Collect(ctx, Version)})
					}()
				}
			}
		}
	}()

	client.Run(ctx)
}
