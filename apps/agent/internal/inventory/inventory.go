// Package inventory собирает полный снимок сервера для панели.
package inventory

import (
	"context"
	"errors"
	"fmt"
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
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Snapshot - снимок для панели (в JSON - ровно proto.Inventory) и состояние упавших сервисов на
// момент снимка (services.Health): после отправки его запоминает services.MarkReported.
type Snapshot struct {
	proto.Inventory
	health string
}

// Health - упавшие сервисы на момент снимка.
func (s Snapshot) Health() string { return s.health }

// collectTimeout - потолок одного сбора: панель ждёт ответа на inventory.get 120 с.
const collectTimeout = 90 * time.Second

// Сборы идут по одному. Вызов во время сбора ждёт следующего, общего для всех, кто пришёл за это
// время: снимок всегда начат после вызова (панель просит его сразу после действия), а
// параллельные вызовы не запускают несколько сборов.
var flight struct {
	sync.Mutex
	running, queued *call
}

type call struct {
	start, done chan struct{}
	snap        Snapshot
	err         error
}

// collectFn - сам сбор (в тестах - заглушка).
var collectFn = collect

// Collect - снимок сервера: сервисы, контейнеры, firewall, сертификаты, аудит. Только чтение.
// Не уложился в collectTimeout - ошибка: неполный снимок выглядел бы для панели пропажей
// сервисов и выключенным firewall.
func Collect(ctx context.Context, agentVersion string) (Snapshot, error) {
	flight.Lock()
	var c *call
	switch {
	case flight.running == nil:
		c = &call{done: make(chan struct{})}
		flight.running = c
		flight.Unlock()
		c.run(ctx, agentVersion)
		return c.snap, c.err
	case flight.queued == nil:
		c = &call{start: make(chan struct{}), done: make(chan struct{})}
		flight.queued = c
		flight.Unlock()
		go func() {
			<-c.start
			c.run(ctx, agentVersion)
		}()
	default:
		c = flight.queued
		flight.Unlock()
	}
	select {
	case <-c.done:
		return c.snap, c.err
	case <-ctx.Done():
		return Snapshot{}, ctx.Err()
	}
}

func (c *call) run(ctx context.Context, agentVersion string) {
	c.snap, c.err = collectFn(ctx, agentVersion)
	flight.Lock()
	next := flight.queued
	flight.running, flight.queued = next, nil
	flight.Unlock()
	close(c.done)
	if next != nil {
		close(next.start)
	}
}

// collect - один сбор. Независимые части идут параллельно: docker stats ждёт секунду на каждый
// контейнер, apt-get -s upgrade - ещё около секунды. Одинаковые команды (ss, journalctl,
// systemctl) выполняются один раз на снимок.
func collect(parent context.Context, agentVersion string) (Snapshot, error) {
	ctx, cancel := context.WithTimeout(shell.WithOutCache(parent), collectTimeout)
	defer cancel()
	inv := proto.Inventory{Host: metrics.Host(agentVersion), Containers: []proto.Container{}}
	var wg sync.WaitGroup
	var pending int
	dockerFailed := false
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
			dockerFailed = true
		}
		if cs == nil {
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
	health := services.Health(ctx, inv.Containers)
	// 3x-ui читается один раз и со списком контейнеров (база может лежать в томе docker): её
	// настройки нужны и сертификатам, и сервисам
	xui, xuiErr := services.ReadXui(ctx, inv.Containers)
	if xuiErr != nil {
		xui = nil
	}
	inv.Unchecked = uncheckedKinds(dockerFailed, xuiErr, xui != nil)
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
	if errors.Is(ctx.Err(), context.DeadlineExceeded) && parent.Err() == nil {
		return Snapshot{}, fmt.Errorf("снимок не собран за %s: сервер отвечает слишком медленно", collectTimeout)
	}
	if err := parent.Err(); err != nil {
		return Snapshot{}, err
	}
	return Snapshot{Inventory: inv, health: health}, nil
}

// uncheckedKinds - виды сервисов, которых может не быть в снимке из-за сбоя чтения, а не потому,
// что их удалили: база 3X-UI не прочиталась, docker не отдал список контейнеров (по ним
// находятся Amnezia и wg-easy, а база 3X-UI бывает в томе контейнера).
func uncheckedKinds(dockerFailed bool, xuiErr error, xuiFound bool) []string {
	out := []string{}
	if xuiErr != nil || (dockerFailed && !xuiFound) {
		out = append(out, "xui")
	}
	if dockerFailed {
		out = append(out, services.ContainerKinds...)
	}
	return out
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
