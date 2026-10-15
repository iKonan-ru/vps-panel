// Package metrics собирает CPU, память, диск, сеть и аптайм хоста.
package metrics

import (
	"context"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

// Metrics соответствует MetricsSchema из packages/protocol.
type Metrics struct {
	CPUPercent  float64 `json:"cpuPercent"`
	MemTotalMb  uint64  `json:"memTotalMb"`
	MemUsedMb   uint64  `json:"memUsedMb"`
	DiskTotalGb float64 `json:"diskTotalGb"`
	DiskUsedGb  float64 `json:"diskUsedGb"`
	NetRxBps    float64 `json:"netRxBps"`
	NetTxBps    float64 `json:"netTxBps"`
	UptimeSec   uint64  `json:"uptimeSec"`
	Load1       float64 `json:"load1"`
}

// HostInfo соответствует HostInfoSchema.
type HostInfo struct {
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Kernel        string `json:"kernel"`
	Arch          string `json:"arch"`
	AgentVersion  string `json:"agentVersion"`
	DockerVersion string `json:"dockerVersion,omitempty"`
	// CPUCores - логические процессоры, доступные системе (vCPU у VPS).
	CPUCores int `json:"cpuCores,omitempty"`
	// CPUModel - строка model name из /proc/cpuinfo как есть: чистит её панель.
	CPUModel string `json:"cpuModel,omitempty"`
}

// Collector считает скорость сети по разнице между вызовами.
type Collector struct {
	lastRx, lastTx uint64
	lastTime       time.Time
}

// virtualIf - интерфейсы, чей трафик уже посчитан на внешнем (veth контейнеров, мосты docker,
// туннели VPN) или не выходит наружу (lo): в сумме он считался бы дважды.
var virtualIf = []string{"lo", "veth", "docker", "br-", "virbr", "wg", "awg", "amn", "tun", "tap", "wdtt"}

// external - байты внешних интерфейсов.
func external(list []net.IOCountersStat) (rx, tx uint64) {
	for _, s := range list {
		virtual := false
		for _, p := range virtualIf {
			if strings.HasPrefix(s.Name, p) {
				virtual = true
				break
			}
		}
		if !virtual {
			rx += s.BytesRecv
			tx += s.BytesSent
		}
	}
	return rx, tx
}

// rates - скорость в бит/с между замерами; счётчик уменьшился (интерфейс пропал или сброшен) -
// замер пропускается: вычитание uint64 переполнилось бы в огромное или отрицательное число.
func (c *Collector) rates(rx, tx uint64, now time.Time) (rxBps, txBps float64, ok bool) {
	dt := now.Sub(c.lastTime).Seconds()
	ok = !c.lastTime.IsZero() && dt > 0 && rx >= c.lastRx && tx >= c.lastTx
	if ok {
		rxBps = round1(float64(rx-c.lastRx) * 8 / dt)
		txBps = round1(float64(tx-c.lastTx) * 8 / dt)
	}
	c.lastRx, c.lastTx, c.lastTime = rx, tx, now
	return rxBps, txBps, ok
}

func NewCollector() *Collector { return &Collector{} }

func (c *Collector) Collect(ctx context.Context) (Metrics, error) {
	var m Metrics
	if pct, err := cpu.PercentWithContext(ctx, 0, false); err == nil && len(pct) > 0 {
		m.CPUPercent = round1(pct[0])
	}
	if v, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		m.MemTotalMb = v.Total / 1024 / 1024
		m.MemUsedMb = v.Used / 1024 / 1024
	}
	if d, err := disk.UsageWithContext(ctx, "/"); err == nil {
		m.DiskTotalGb = round1(float64(d.Total) / 1e9)
		m.DiskUsedGb = round1(float64(d.Used) / 1e9)
	}
	if up, err := host.UptimeWithContext(ctx); err == nil {
		m.UptimeSec = up
	}
	if l, err := load.AvgWithContext(ctx); err == nil {
		m.Load1 = round1(l.Load1)
	}
	if io, err := net.IOCountersWithContext(ctx, true); err == nil {
		rx, tx := external(io)
		m.NetRxBps, m.NetTxBps, _ = c.rates(rx, tx, time.Now())
	}
	return m, nil
}

func Host(agentVersion string) HostInfo {
	hi := HostInfo{Arch: runtime.GOARCH, AgentVersion: agentVersion, CPUCores: runtime.NumCPU()}
	if list, err := cpu.Info(); err == nil && len(list) > 0 {
		hi.CPUModel = strings.TrimSpace(list[0].ModelName)
	}
	if info, err := host.Info(); err == nil {
		hi.Hostname = info.Hostname
		hi.OS = info.Platform + " " + info.PlatformVersion
		hi.Kernel = info.KernelVersion
	}
	return hi
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }
