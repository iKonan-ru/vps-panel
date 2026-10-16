// Package backup - бэкап конфигов сервисов в панель и восстановление на другой сервер.
//
// Компоненты: xui (/etc/x-ui), wdtt (/etc/wdtt), mtproxyl (/opt/mtproxyl), amnezia
// (/opt/amnezia из каждого контейнера amnezia-*), certs (/root/.acme.sh, /root/cert),
// portsync (/etc/vps-portsync). Архив tar.gz с manifest.json в корне.
// Восстановление только раскладывает данные: сервисы на целевом сервере должны быть
// уже установлены (командами каталога), контейнеры Amnezia - с теми же именами.
package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

type Component struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Paths на хосте (архивируются как есть, с ведущего /).
	Paths []string `json:"paths,omitempty"`
	// Containers: имена контейнеров, из которых копируется /opt/amnezia.
	Containers []string `json:"containers,omitempty"`
	SizeBytes  int64    `json:"sizeBytes"`
}

type Manifest struct {
	Version     int         `json:"version"`
	Hostname    string      `json:"hostname"`
	CreatedAt   string      `json:"createdAt"`
	Agent       string      `json:"agent"`
	Components  []Component `json:"components"`
	Sha256      string      `json:"sha256,omitempty"`
	ArchiveSize int64       `json:"archiveSize,omitempty"`
	// Setup - что стояло на сервере (сервисы, ответы команд, AWG), снимок панели: по нему
	// панель разворачивает копию на чистый сервер, в том числе из скачанного файла.
	Setup json.RawMessage `json:"setup,omitempty"`
}

// Detect возвращает компоненты, которые есть на этом сервере.
func Detect(ctx context.Context) []Component {
	var out []Component
	add := func(id, title string, paths ...string) {
		var have []string
		var size int64
		for _, p := range paths {
			if st, err := os.Stat(p); err == nil {
				have = append(have, p)
				size += dirSize(p, st)
			}
		}
		if len(have) > 0 {
			out = append(out, Component{ID: id, Title: title, Paths: have, SizeBytes: size})
		}
	}
	if services.ReadXuiDBConfig().Type == "postgres" {
		add("xui", "3X-UI: настройки и дамп базы PostgreSQL", "/etc/x-ui", "/etc/default/x-ui")
	} else {
		add("xui", "3X-UI: база и настройки", "/etc/x-ui")
	}
	add("wdtt", "WDTT: пароли, ключи, токены", "/etc/wdtt")
	add("mtproxyl", "MTProxyL: конфиг и пользователи", "/opt/mtproxyl")
	add("certs", "Сертификаты и аккаунт acme.sh", "/root/.acme.sh", "/root/cert")
	add("portsync", "port-sync: настройки", "/etc/vps-portsync.conf")
	if names := containerNames(ctx, "amnezia-"); len(names) > 0 {
		out = append(out, Component{ID: "amnezia", Title: "Amnezia: ключи и пользователи контейнеров " + strings.Join(names, ", "), Containers: names})
	}
	if out == nil {
		out = []Component{}
	}
	return out
}

// containerNames - имена контейнеров (и остановленных) с префиксом; docker недоступен - пусто.
func containerNames(ctx context.Context, prefix string) []string {
	if !dockerapi.Available() {
		return nil
	}
	list, _ := dockerapi.New().List(ctx)
	var names []string
	for _, c := range list {
		if strings.HasPrefix(c.Name, prefix) {
			names = append(names, c.Name)
		}
	}
	return names
}

func dirSize(p string, st os.FileInfo) int64 {
	if !st.IsDir() {
		return st.Size()
	}
	var n int64
	_ = filepath.Walk(p, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			n += info.Size()
		}
		return nil
	})
	return n
}

type CreateParams struct {
	Components []string `json:"components"` // пусто = все найденные
	UploadURL  string   `json:"uploadUrl"`
	Token      string   `json:"token"` // Bearer для загрузки в панель
	Hostname   string   `json:"hostname"`
	Agent      string   `json:"agent"`
	// Setup - снимок набора сервера от панели, кладётся в manifest.json как есть.
	Setup json.RawMessage `json:"setup,omitempty"`
}

// maxSetup - предел снимка набора: это несколько строк JSON, не данные.
const maxSetup = 256 << 10

// Create собирает архив и загружает его в панель. Возвращает манифест с размером и sha256.
func Create(ctx context.Context, p CreateParams, stream func(channel, chunk string)) (*Manifest, error) {
	log := func(f string, a ...any) { stream("log", fmt.Sprintf(f, a...)+"\n") }
	all := Detect(ctx)
	var chosen []Component
	for _, c := range all {
		if len(p.Components) == 0 || slices.Contains(p.Components, c.ID) {
			chosen = append(chosen, c)
		}
	}
	if len(chosen) == 0 {
		return nil, errors.New("на сервере нечего сохранять: нет 3X-UI, WDTT, MTProxyL, Amnezia и сертификатов")
	}
	tmpDir, err := os.MkdirTemp("/var/tmp", "vps-backup-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)
	archive := filepath.Join(tmpDir, "backup.tar.gz")
	f, err := os.OpenFile(archive, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)

	man := Manifest{Version: 1, Hostname: p.Hostname, CreatedAt: time.Now().UTC().Format(time.RFC3339), Agent: p.Agent}
	if len(p.Setup) > 0 && len(p.Setup) <= maxSetup && json.Valid(p.Setup) {
		man.Setup = p.Setup
	}
	for _, c := range chosen {
		log("== %s", c.Title)
		for _, path := range c.Paths {
			if err := addPath(tw, path, strings.TrimPrefix(path, "/")); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
		}
		if c.ID == "xui" {
			if cfg := services.ReadXuiDBConfig(); cfg.Type == "postgres" {
				// sqlite-файл при PostgreSQL пустой: настоящие данные - в дампе
				dump, err := pgDump(ctx, cfg.DSN, filepath.Join(tmpDir, xuiPgDump))
				if err != nil {
					return nil, fmt.Errorf("3X-UI: pg_dump: %w", err)
				}
				log("  дамп PostgreSQL: %d КБ", dump/1024)
				if err := addPath(tw, filepath.Join(tmpDir, xuiPgDump), "etc/x-ui/"+xuiPgDump); err != nil {
					return nil, err
				}
			}
		}
		for _, cn := range c.Containers {
			dst := filepath.Join(tmpDir, "containers", cn)
			if err := os.MkdirAll(dst, 0o700); err != nil {
				return nil, err
			}
			res, err := shell.Run(ctx, fmt.Sprintf("docker cp %s:/opt/amnezia %s/", shell.Quote(cn), shell.Quote(dst)), 2*time.Minute, nil)
			if err != nil || res.ExitCode != 0 {
				log("  контейнер %s: не удалось скопировать /opt/amnezia (%s)", cn, strings.TrimSpace(res.Stderr))
				continue
			}
			if err := addPath(tw, dst, filepath.Join("containers", cn)); err != nil {
				return nil, err
			}
		}
		man.Components = append(man.Components, c)
	}
	mj, _ := json.MarshalIndent(man, "", "  ")
	if err := tw.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0o600, Size: int64(len(mj)), ModTime: time.Now()}); err != nil {
		return nil, err
	}
	if _, err := tw.Write(mj); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	st, _ := os.Stat(archive)
	man.ArchiveSize = st.Size()
	man.Sha256, _ = fileSum(archive)
	log("== архив %s, %d КБ, sha256 %s", filepath.Base(archive), st.Size()/1024, man.Sha256[:12])

	if p.UploadURL != "" {
		log("== загрузка в панель")
		if err := upload(ctx, p.UploadURL, p.Token, archive); err != nil {
			return nil, err
		}
		log("== загружено")
	}
	return &man, nil
}

func addPath(tw *tar.Writer, root, prefix string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		name := prefix
		if rel != "." {
			name = filepath.Join(prefix, rel)
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, _ = os.Readlink(path)
		}
		hdr, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		hdr.Name = name
		if info.IsDir() {
			hdr.Name += "/"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			fh, err := os.Open(path)
			if err != nil {
				return err
			}
			defer fh.Close()
			if _, err := io.Copy(tw, fh); err != nil {
				return err
			}
		}
		return nil
	})
}

func upload(ctx context.Context, url, token, archive string) error {
	fh, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer fh.Close()
	st, _ := fh.Stat()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, fh)
	if err != nil {
		return err
	}
	req.ContentLength = st.Size()
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/gzip")
	cl := &http.Client{Timeout: 10 * time.Minute}
	resp, err := cl.Do(req)
	if err != nil {
		return fmt.Errorf("загрузка: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
		return fmt.Errorf("панель ответила %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func fileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
