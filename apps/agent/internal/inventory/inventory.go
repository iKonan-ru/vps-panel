// Package inventory собирает полный снимок сервера для панели.
package inventory

import (
	"context"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/audit"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/certs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/metrics"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
)

// Collect - услуги, контейнеры, firewall, аудит. Только чтение.
// Независимые части идут параллельно: docker stats ждёт секунду на каждый контейнер,
// apt-get -s upgrade - ещё около секунды; последовательно снимок занимал 6-7 с.
func Collect(ctx context.Context, agentVersion string) proto.Inventory {
	inv := proto.Inventory{Host: metrics.Host(agentVersion), Containers: []proto.Container{}}
	var wg sync.WaitGroup
	var pending int
	wg.Add(3)
	go func() {
		defer wg.Done()
		if !dockerapi.Available() {
			return
		}
		d := dockerapi.New()
		inv.Host.DockerVersion = d.Version(ctx)
		cs, err := d.List(ctx)
		if err != nil {
			return
		}
		var sw sync.WaitGroup
		for i := range cs {
			if cs[i].State != "running" {
				continue
			}
			sw.Add(1)
			go func(i int) {
				defer sw.Done()
				if cpu, mem, err := d.Stats(ctx, cs[i].ID); err == nil {
					c, m := cpu, float64(int(mem*10))/10
					cs[i].CPUPercent, cs[i].MemMb = &c, &m
				}
			}(i)
		}
		sw.Wait()
		inv.Containers = cs
	}()
	go func() {
		defer wg.Done()
		inv.Firewall = firewall.State(ctx)
	}()
	go func() {
		defer wg.Done()
		pending = audit.PendingUpdates(ctx)
	}()
	wg.Wait()
	// до сбора сервисов: упавшее, что поднимется во время сбора, проверка раз в 30 с заметит
	// и пришлёт новый снимок (services.Reported)
	services.MarkReported(services.Health(ctx, inv.Containers))
	// 3x-ui читается один раз и со списком контейнеров (база может лежать в томе docker): её
	// настройки нужны и сертификатам, и сервисам
	xui, err := services.ReadXui(ctx, inv.Containers)
	if err != nil {
		xui = nil
	}
	var cw sync.WaitGroup
	cw.Add(1)
	go func() {
		defer cw.Done()
		inv.Certs = certs.Scan(ctx, inv.Containers, xui)
	}()
	inv.Services = services.Detect(ctx, inv.Containers, PublicIP(), xui)
	cw.Wait()
	inv.Audit = audit.Run(ctx, inv.Firewall, inv.Containers, inv.Services, inv.Certs, pending)
	inv.CollectedAt = time.Now().UTC().Format(time.RFC3339)
	return inv
}

// PublicIP - адрес интерфейса с маршрутом по умолчанию.
func PublicIP() string {
	conn, err := net.Dial("udp", "1.1.1.1:53")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	return strings.Split(conn.LocalAddr().String(), ":")[0]
}
