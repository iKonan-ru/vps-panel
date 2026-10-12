package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// reSha256 - формат контрольной суммы архива.
var reSha256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// CheckPanelURL - адрес загрузки или скачивания бэкапа - на той же панели, что и в
// agent.json: архив со всеми секретами сервера не уходит на чужой адрес.
func CheckPanelURL(raw, panelURL string) error {
	u, err1 := url.Parse(raw)
	p, err2 := url.Parse(panelURL)
	if err1 != nil || err2 != nil || u.Host == "" || u.Scheme != p.Scheme || !strings.EqualFold(u.Host, p.Host) {
		return fmt.Errorf("адрес резервной копии %q не ведёт на панель", raw)
	}
	return nil
}

type RestoreParams struct {
	DownloadURL string   `json:"downloadUrl"`
	Sha256      string   `json:"sha256"`
	Components  []string `json:"components"` // пусто = все из архива
}

// Restore скачивает архив, проверяет sha256 и раскладывает выбранные компоненты.
func Restore(ctx context.Context, p RestoreParams, stream func(channel, chunk string)) error {
	log := func(f string, a ...any) { stream("log", fmt.Sprintf(f, a...)+"\n") }
	// что не восстановилось: итог - "частично" с перечнем, а не "Готово" с ok
	var failed []string
	runR := func(cmd string) {
		if !run(ctx, stream, cmd) {
			failed = append(failed, cmd)
		}
	}
	tmpDir, err := os.MkdirTemp("/var/tmp", "vps-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	archive := filepath.Join(tmpDir, "backup.tar.gz")
	// sha256 обязателен: его панель записала при загрузке и передаёт по
	// защищённому каналу - архив не подменить, даже захватив домен панели
	if !reSha256.MatchString(p.Sha256) {
		return errors.New("нужна контрольная сумма архива (sha256)")
	}
	log("== скачиваю архив")
	if err := download(ctx, p.DownloadURL, archive); err != nil {
		return err
	}
	if sum, _ := fileSum(archive); sum != p.Sha256 {
		return errors.New("контрольная сумма архива не совпала")
	}
	ex := filepath.Join(tmpDir, "x")
	if err := os.MkdirAll(ex, 0o700); err != nil {
		return err
	}
	if err := extractTarGz(archive, ex, log); err != nil {
		return fmt.Errorf("не удалось распаковать архив: %w", err)
	}
	raw, err := os.ReadFile(filepath.Join(ex, "manifest.json"))
	if err != nil {
		return errors.New("в архиве нет manifest.json")
	}
	var man Manifest
	if err := json.Unmarshal(raw, &man); err != nil {
		return err
	}
	log("== резервная копия с %s от %s", man.Hostname, man.CreatedAt)
	copyR := func(dst string) {
		if !copyBack(ex, dst, log) {
			failed = append(failed, dst)
		}
	}

	for _, c := range man.Components {
		if len(p.Components) > 0 && !slices.Contains(p.Components, c.ID) {
			continue
		}
		log("== %s", c.Title)
		switch c.ID {
		case "xui":
			if _, err := os.Stat("/usr/local/x-ui/x-ui"); err != nil {
				log("  3X-UI не установлен на этом сервере - сначала команда 3X-UI; пропускаю")
				continue
			}
			dumpPath := filepath.Join(ex, "etc/x-ui", xuiPgDump)
			_, hasDump := os.Stat(dumpPath)
			cfg := services.ReadXuiDBConfig()
			switch {
			case hasDump == nil && cfg.Type == "postgres":
				runR("systemctl stop x-ui")
				copyR("/etc/x-ui")
				_ = os.Remove(filepath.Join("/etc/x-ui", xuiPgDump))
				log("  восстанавливаю базу PostgreSQL из дампа (таблицы пересоздаются)")
				if err := pgRestore(ctx, cfg.DSN, dumpPath, stream); err != nil {
					runR("systemctl start x-ui")
					return fmt.Errorf("3X-UI: восстановление PostgreSQL: %w", err)
				}
				runR("systemctl start x-ui")
			case hasDump == nil:
				log("  копия сделана с 3X-UI на PostgreSQL, а здесь 3X-UI на sqlite: базу перенести нельзя, пропускаю")
				continue
			case cfg.Type == "postgres":
				log("  копия сделана с 3X-UI на sqlite, а здесь PostgreSQL: базу перенести нельзя, пропускаю")
				continue
			default:
				runR("systemctl stop x-ui")
				copyR("/etc/x-ui")
				runR("systemctl start x-ui")
			}
		case "wdtt":
			if _, err := os.Stat("/usr/local/bin/wdtt-server"); err != nil {
				log("  WDTT не установлен - сначала команда WDTT; пропускаю")
				continue
			}
			runR("systemctl stop wdtt")
			copyR("/etc/wdtt")
			runR("systemctl start wdtt")
		case "mtproxyl":
			if !shell.Has("mtproxyl") {
				log("  MTProxyL не установлен - сначала команда MTProxyL; пропускаю")
				continue
			}
			copyR("/opt/mtproxyl")
			runR("mtproxyl restart 2>/dev/null || systemctl restart mtproxyl 2>/dev/null || true")
		case "certs":
			for _, d := range []string{"/root/.acme.sh", "/root/cert"} {
				copyR(d)
			}
			runR("[ -x /root/.acme.sh/acme.sh ] && /root/.acme.sh/acme.sh --install-cronjob >/dev/null 2>&1 || true")
			log("  сертификаты домена действуют, если DNS домена уже указывает на этот сервер; сертификаты на IP старого сервера здесь бесполезны")
		case "portsync":
			copyR("/etc/vps-portsync.conf")
			runR("systemctl start vps-portsync.service 2>/dev/null || true")
		case "amnezia":
			for _, cn := range c.Containers {
				src := filepath.Join(ex, "containers", cn, "amnezia")
				if _, err := os.Stat(src); err != nil {
					log("  в архиве нет данных контейнера %s", cn)
					continue
				}
				if !slices.Contains(containerNames(ctx, cn), cn) {
					log("  контейнера %s нет на этом сервере - сначала команда Amnezia AWG; пропускаю", cn)
					continue
				}
				runR(fmt.Sprintf("docker cp %s/. %s:/opt/amnezia/ && docker restart %s", shell.Quote(src), shell.Quote(cn), shell.Quote(cn)))
				log("  контейнер %s: данные восстановлены, перезапущен. Порт в awg0.conf должен совпадать с опубликованным портом контейнера.", cn)
			}
		default:
			log("  неизвестный компонент %s, пропускаю", c.ID)
		}
	}
	if len(failed) > 0 {
		log("== Готово с ошибками, не восстановлено: %s", strings.Join(failed, ", "))
		return fmt.Errorf("восстановлено частично, ошибки: %s", strings.Join(failed, "; "))
	}
	log("== Готово")
	return nil
}

func run(ctx context.Context, stream func(string, string), cmd string) bool {
	res, err := shell.Run(ctx, cmd, 3*time.Minute, stream)
	if err != nil {
		stream("stderr", err.Error()+"\n")
		return false
	}
	if res.ExitCode != 0 {
		stream("stderr", fmt.Sprintf("команда завершилась с кодом %d: %s\n", res.ExitCode, cmd))
		return false
	}
	return true
}

// copyBack переносит каталог из распакованного архива на место, сохраняя старую копию рядом.
// false - не удалось; чего нет в архиве, то не ошибка.
func copyBack(ex, dst string, log func(string, ...any)) bool {
	src := filepath.Join(ex, strings.TrimPrefix(dst, "/"))
	if _, err := os.Stat(src); err != nil {
		log("  в архиве нет %s", dst)
		return true
	}
	if _, err := os.Stat(dst); err == nil {
		bak := dst + ".before-restore-" + time.Now().Format("20060102-150405")
		if err := os.Rename(dst, bak); err == nil {
			log("  старое %s сохранено как %s", dst, bak)
		}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		log("  %s: %v", dst, err)
		return false
	}
	if err := os.Rename(src, dst); err != nil {
		// разные файловые системы - копируем
		res, e2 := shell.Run(context.Background(), fmt.Sprintf("cp -a %s %s", shell.Quote(src), shell.Quote(dst)), 5*time.Minute, nil)
		if e2 != nil || res.ExitCode != 0 {
			log("  %s: не удалось восстановить", dst)
			return false
		}
	}
	log("  %s восстановлен", dst)
	return true
}

func download(ctx context.Context, url, dst string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	cl := &http.Client{Timeout: 10 * time.Minute}
	resp, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("панель ответила %d", resp.StatusCode)
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, io.LimitReader(resp.Body, maxUntarBytes))
	return err
}
