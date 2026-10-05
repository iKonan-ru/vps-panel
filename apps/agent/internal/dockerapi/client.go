// Package dockerapi - минимальный клиент Docker Engine API через unix-сокет.
// Только чтение и старт/стоп/рестарт/удаление/логи: без сборки, сетей, томов.
package dockerapi

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

const socketPath = "/var/run/docker.sock"

type Client struct{ http *http.Client }

// transport - один на процесс: свой транспорт на каждый New() держал keep-alive соединение
// и две горутины навсегда (без IdleConnTimeout), а New() зовут на каждый снимок инвентаря.
var transport = &http.Transport{
	DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socketPath)
	},
	MaxIdleConns:    4,
	IdleConnTimeout: 90 * time.Second,
}

func New() *Client {
	return &Client{http: &http.Client{Transport: transport, Timeout: 60 * time.Second}}
}

// Available - есть ли сокет docker на этой машине.
func Available() bool {
	_, err := os.Stat(socketPath)
	return err == nil
}

func (c *Client) do(ctx context.Context, method, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(b, &e)
		if e.Message == "" {
			e.Message = resp.Status
		}
		return errors.New("docker: " + e.Message)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) Version(ctx context.Context) string {
	var v struct {
		Version string `json:"Version"`
	}
	if err := c.do(ctx, "GET", "/version", &v); err != nil {
		return ""
	}
	return v.Version
}

type inspect struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	State struct {
		Status string `json:"Status"`
	} `json:"State"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	HostConfig struct {
		NetworkMode  string                         `json:"NetworkMode"`
		PortBindings map[string][]map[string]string `json:"PortBindings"`
	} `json:"HostConfig"`
}

// List - контейнеры (включая остановленные) с опубликованными портами и compose-проектом.
func (c *Client) List(ctx context.Context) ([]proto.Container, error) {
	var items []struct {
		ID     string `json:"Id"`
		Status string `json:"Status"`
	}
	if err := c.do(ctx, "GET", "/containers/json?all=1", &items); err != nil {
		return nil, err
	}
	var out []proto.Container
	for _, it := range items {
		var in inspect
		if err := c.do(ctx, "GET", "/containers/"+it.ID+"/json", &in); err != nil {
			continue
		}
		ct := proto.Container{
			ID:             in.ID[:12],
			Name:           strings.TrimPrefix(in.Name, "/"),
			Image:          in.Config.Image,
			State:          in.State.Status,
			Status:         it.Status,
			NetworkMode:    in.HostConfig.NetworkMode,
			Published:      []string{},
			ComposeProject: in.Config.Labels["com.docker.compose.project"],
		}
		for cport, binds := range in.HostConfig.PortBindings {
			for _, b := range binds {
				ip := b["HostIp"]
				if ip == "" {
					ip = "0.0.0.0"
				}
				ct.Published = append(ct.Published, fmt.Sprintf("%s:%s->%s", ip, b["HostPort"], cport))
			}
		}
		sort.Strings(ct.Published)
		out = append(out, ct)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if out == nil {
		out = []proto.Container{}
	}
	return out, nil
}

// Stats - CPU % и память контейнера одним замером (без stream).
type cpuSample struct{ total, system uint64 }

// Прошлые замеры CPU по id контейнера: среднее с прошлого снимка inventory.
var (
	statsMu   sync.Mutex
	lastStats = map[string]cpuSample{}
)

func (c *Client) Stats(ctx context.Context, id string) (cpu, memMb float64, err error) {
	var s struct {
		CPUStats struct {
			CPUUsage struct {
				TotalUsage uint64 `json:"total_usage"`
			} `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
			OnlineCPUs  uint64 `json:"online_cpus"`
		} `json:"cpu_stats"`
		PreCPUStats struct {
			CPUUsage struct {
				TotalUsage uint64 `json:"total_usage"`
			} `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
		} `json:"precpu_stats"`
		MemoryStats struct {
			Usage uint64            `json:"usage"`
			Stats map[string]uint64 `json:"stats"`
		} `json:"memory_stats"`
	}
	// one-shot: docker отдаёт один замер сразу, без секундной паузы на второй.
	// CPU считаем по разнице с прошлым замером этого же контейнера (первый раз - 0).
	if err = c.do(ctx, "GET", "/containers/"+id+"/stats?stream=false&one-shot=true", &s); err != nil {
		return 0, 0, err
	}
	statsMu.Lock()
	prev, ok := lastStats[id]
	lastStats[id] = cpuSample{s.CPUStats.CPUUsage.TotalUsage, s.CPUStats.SystemUsage}
	statsMu.Unlock()
	if ok && s.CPUStats.SystemUsage > prev.system && s.CPUStats.CPUUsage.TotalUsage > prev.total {
		cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage - prev.total)
		sysDelta := float64(s.CPUStats.SystemUsage - prev.system)
		n := float64(s.CPUStats.OnlineCPUs)
		if n == 0 {
			n = 1
		}
		cpu = cpuDelta / sysDelta * n * 100
	}
	usage := s.MemoryStats.Usage
	if cache, ok := s.MemoryStats.Stats["inactive_file"]; ok && cache < usage {
		usage -= cache
	}
	return float64(int(cpu*10)) / 10, float64(usage) / 1024 / 1024, nil
}

// Action: start | stop | restart | remove. remove только для остановленных.
func (c *Client) Action(ctx context.Context, id, action string) error {
	switch action {
	case "start", "stop", "restart":
		return c.do(ctx, "POST", "/containers/"+url.PathEscape(id)+"/"+action, nil)
	case "remove":
		return c.do(ctx, "DELETE", "/containers/"+url.PathEscape(id), nil)
	}
	return errors.New("unknown action: " + action)
}

// Logs - последние tail строк stdout+stderr. Docker мультиплексирует потоки
// 8-байтовыми заголовками, если у контейнера нет tty.
func (c *Client) Logs(ctx context.Context, id string, tail int) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET",
		fmt.Sprintf("http://docker/containers/%s/logs?stdout=1&stderr=1&timestamps=1&tail=%d", url.PathEscape(id), tail), nil)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return "", errors.New("docker: " + resp.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	if resp.Header.Get("Content-Type") == "application/vnd.docker.multiplexed-stream" || looksMultiplexed(raw) {
		return demux(raw), nil
	}
	return string(raw), nil
}

func looksMultiplexed(b []byte) bool {
	return len(b) >= 8 && (b[0] == 1 || b[0] == 2) && b[1] == 0 && b[2] == 0 && b[3] == 0
}

func demux(b []byte) string {
	var sb strings.Builder
	for len(b) >= 8 {
		n := int(binary.BigEndian.Uint32(b[4:8]))
		if 8+n > len(b) {
			break
		}
		sb.Write(b[8 : 8+n])
		b = b[8+n:]
	}
	return sb.String()
}
