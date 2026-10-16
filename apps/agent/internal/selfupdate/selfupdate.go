// Package selfupdate скачивает свежий бинарник агента с панели и перезапускает службу. Канал до
// панели бывает очень узким, поэтому качается сжатая копия с докачкой по Range, а таймаут - только
// на молчание (и потолок в 45 минут).
package selfupdate

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/fsutil"
)

const (
	binPath      = "/usr/local/bin/vps-agent"
	stallTimeout = 60 * time.Second
	totalLimit   = 45 * time.Minute
)

// ErrUpToDate - на сервере уже последний бинарник.
var ErrUpToDate = errors.New("уже установлена последняя версия")

// Отмена из панели (agent.update.cancel) прерывает все идущие и ждущие обновления; обновляет
// бинарник только одно за раз (running).
var (
	curMu   sync.Mutex
	cancels = map[int]context.CancelFunc{}
	nextID  int
	running = make(chan struct{}, 1)
)

// Cancel прерывает идущее обновление. false - ничего не шло.
func Cancel() bool {
	curMu.Lock()
	defer curMu.Unlock()
	for _, c := range cancels {
		c()
	}
	return len(cancels) > 0
}

func track(cancel context.CancelFunc) (untrack func()) {
	curMu.Lock()
	defer curMu.Unlock()
	id := nextID
	nextID++
	cancels[id] = cancel
	return func() {
		curMu.Lock()
		delete(cancels, id)
		curMu.Unlock()
	}
}

// reSha256 - формат контрольной суммы: из неё собираются имена файлов.
var reSha256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// maxBinary - потолок распакованного бинарника: gzip-бомба не заполнит диск.
const maxBinary = 256 << 20

// Run качает бинарник для своей архитектуры, сверяет sha256 и подменяет файл. Контрольные суммы
// приходят в самом запросе agent.update по защищённому каналу: подменить бинарник, захватив только
// домен панели, нельзя. Перезапуск службы - отдельным процессом с задержкой, чтобы ответ панели
// успел уйти. Возвращает контрольную сумму нового файла.
func Run(ctx context.Context, panelURL string, sums map[string]string, log func(string)) (string, error) {
	if log == nil {
		log = func(string) {}
	}
	arch := "linux-" + runtime.GOARCH
	want := sums[arch]
	if want == "" {
		return "", fmt.Errorf("на панели нет агента для %s", arch)
	}
	if !reSha256.MatchString(want) {
		return "", errors.New("неверная контрольная сумма агента")
	}
	if cur, err := fsutil.FileSum(binPath); err == nil && cur == want {
		return want, ErrUpToDate
	}

	ctx, cancel := context.WithTimeout(ctx, totalLimit)
	defer cancel()
	defer track(cancel)()
	select {
	case running <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-running }()
	// пока ждали, бинарник мог заменить предыдущий запрос
	if cur, err := fsutil.FileSum(binPath); err == nil && cur == want {
		return want, ErrUpToDate
	}
	// недокачанные куски других версий больше не нужны
	if old, _ := filepath.Glob("/var/tmp/vps-agent.*.part*"); len(old) > 0 {
		for _, o := range old {
			if !strings.Contains(o, want[:12]) {
				_ = os.Remove(o)
			}
		}
	}
	part := "/var/tmp/vps-agent." + want[:12] + ".gz.part"
	url := panelURL + "/agent/download/" + arch + ".gz"
	gz := true
	if err := download(ctx, url, part, log); err != nil {
		if !errors.Is(err, errNotFound) {
			return "", err
		}
		// панель без сжатой копии - качаем как есть
		gz = false
		part = "/var/tmp/vps-agent." + want[:12] + ".part"
		if err := download(ctx, panelURL+"/agent/download/"+arch, part, log); err != nil {
			return "", err
		}
	}
	defer os.Remove(part)

	tmp, err := os.CreateTemp("/usr/local/bin", ".vps-agent-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	src, err := os.Open(part)
	if err != nil {
		return "", err
	}
	defer src.Close()
	var body io.Reader = src
	if gz {
		zr, err := gzip.NewReader(src)
		if err != nil {
			return "", fmt.Errorf("распаковка: %w", err)
		}
		defer zr.Close()
		body = zr
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(body, maxBinary+1))
	if err != nil {
		tmp.Close()
		return "", fmt.Errorf("распаковка: %w", err)
	}
	if n > maxBinary {
		tmp.Close()
		return "", errors.New("бинарник больше 256 МБ: не похоже на агента")
	}
	tmp.Close()
	got := hex.EncodeToString(h.Sum(nil))
	if got != want {
		return "", fmt.Errorf("контрольная сумма не совпала: %s != %s", got[:12], want[:12])
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return "", err
	}
	// Новый бинарник должен хотя бы запуститься: битая сборка или чужая архитектура иначе
	// заменили бы рабочего агента, и чинить пришлось бы по SSH.
	vc, cancel := context.WithTimeout(ctx, 10*time.Second)
	out, err := exec.CommandContext(vc, tmp.Name(), "-version").Output()
	cancel()
	if err != nil || len(bytes.TrimSpace(out)) == 0 {
		return "", fmt.Errorf("новый бинарник не запускается: %v", err)
	}
	// прежний - рядом, для отката руками: mv vps-agent.prev vps-agent
	_ = os.Remove(binPath + ".prev")
	_ = os.Link(binPath, binPath+".prev")
	if err := os.Rename(tmp.Name(), binPath); err != nil {
		return "", err
	}
	log("бинарник заменён, перезапуск службы через 2 с")
	// systemd перезапустит нас через 2 секунды; ответ панели уйдёт раньше.
	cmd := exec.Command("sh", "-c", "sleep 2; systemctl restart vps-agent")
	if err := cmd.Start(); err != nil {
		return got, fmt.Errorf("бинарник заменён, но перезапуск не удался: %w", err)
	}
	_ = cmd.Process.Release()
	return got, nil
}

var errNotFound = errors.New("not found")

const (
	streams  = 4          // параллельных соединений: узкий канал часто режет скорость на поток
	minSplit = 512 * 1024 // меньше - качаем одним потоком
	slowRate = 30 * 1024  // байт/с: ниже этого предупреждаем в выводе
)

// downloader - одна загрузка: общий счётчик для прогресса и отмена.
type downloader struct {
	log   func(string)
	total int64
	done  atomic.Int64
	start time.Time
}

// download скачивает url в dst: узнаёт размер, режет на streams частей, каждую качает
// докачкой по Range с продолжением после обрывов, потом склеивает. Если панель не
// умеет Range или размер неизвестен - один поток с докачкой.
func download(ctx context.Context, url, dst string, log func(string)) error {
	total, ranges, err := probe(ctx, url)
	if err != nil {
		return err
	}
	d := &downloader{log: log, total: total, start: time.Now()}
	if !ranges || total < minSplit {
		return d.part(ctx, url, dst, 0, total-1)
	}
	// прогресс раз в 10 с: объём, процент, скорость, оценка; предупреждение про узкий канал
	pctx, stop := context.WithCancel(ctx)
	defer stop()
	go d.report(pctx)

	n := int64(streams)
	chunk := (total + n - 1) / n
	errs := make(chan error, n)
	for i := int64(0); i < n; i++ {
		from, to := i*chunk, min((i+1)*chunk, total)-1
		if from > to {
			errs <- nil
			continue
		}
		go func(i, from, to int64) {
			errs <- d.part(ctx, url, fmt.Sprintf("%s.%d", dst, i), from, to)
		}(i, from, to)
	}
	var first error
	for i := int64(0); i < n; i++ {
		if e := <-errs; e != nil && first == nil {
			first = e
		}
	}
	if first != nil {
		return first
	}
	stop()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	for i := int64(0); i < n; i++ {
		name := fmt.Sprintf("%s.%d", dst, i)
		p, err := os.Open(name)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			out.Close()
			return err
		}
		_, err = io.Copy(out, p)
		p.Close()
		if err != nil {
			out.Close()
			return err
		}
		_ = os.Remove(name)
	}
	if err := out.Close(); err != nil {
		return err
	}
	log(fmt.Sprintf("скачано %s за %s", mb(total), time.Since(d.start).Round(time.Second)))
	return nil
}

// probe узнаёт размер и поддержку Range одним запросом первого байта.
func probe(ctx context.Context, url string) (total int64, ranges bool, err error) {
	cl := &http.Client{Timeout: time.Minute}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Range", "bytes=0-0")
	resp, err := cl.Do(req)
	if err != nil {
		return 0, false, fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16))
	switch resp.StatusCode {
	case http.StatusPartialContent:
		var a, b int64
		if _, e := fmt.Sscanf(resp.Header.Get("Content-Range"), "bytes %d-%d/%d", &a, &b, &total); e != nil {
			return 0, false, errors.New("панель не сообщила размер файла")
		}
		return total, true, nil
	case http.StatusOK:
		return resp.ContentLength, false, nil
	case http.StatusNotFound:
		return 0, false, errNotFound
	default:
		return 0, false, fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}
}

func (d *downloader) report(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	warned := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			got := d.done.Load()
			el := time.Since(d.start).Seconds()
			rate := float64(got) / el
			line := fmt.Sprintf("скачано %s из %s (%d%%), %s/с", mb(got), mb(d.total), got*100/max(d.total, 1), mb(int64(rate)))
			if rate > 0 {
				line += fmt.Sprintf(", осталось ~%s", (time.Duration(float64(d.total-got)/rate) * time.Second).Round(time.Second))
			}
			d.log(line)
			if !warned && el > 30 && rate < slowRate {
				warned = true
				d.log("канал от панели к серверу сейчас очень узкий; загрузка продолжится, можно отменить и повторить позже")
			}
		}
	}
}

// part докачивает байты [from, to] в файл dst (в нём уже может лежать начало).
func (d *downloader) part(ctx context.Context, url, dst string, from, to int64) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	have, _ := f.Seek(0, io.SeekEnd)
	if to >= 0 && have > to-from+1 {
		// файл длиннее, чем надо: что-то не так, начинаем часть заново
		_ = f.Truncate(0)
		have = 0
	}
	d.done.Add(have)
	if to >= 0 && have == to-from+1 {
		return nil
	}
	cl := &http.Client{} // без общего таймаута: только на молчание
	stalls := 0
	for attempt := 0; ; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(3 * time.Second):
			}
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if to >= 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from+have, to))
		} else if have > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
		}
		resp, err := cl.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if attempt >= 20 {
				return fmt.Errorf("download: %w", err)
			}
			continue
		}
		if resp.StatusCode != http.StatusPartialContent && !(resp.StatusCode == http.StatusOK && have == 0 && from == 0) {
			resp.Body.Close()
			if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
				return nil
			}
			return fmt.Errorf("download: HTTP %d", resp.StatusCode)
		}
		n, err := d.copy(ctx, f, resp.Body)
		resp.Body.Close()
		have += n
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if n == 0 {
			if stalls++; stalls >= 8 {
				return fmt.Errorf("связь с панелью не даёт данных: %w", err)
			}
		} else {
			stalls = 0
		}
	}
}

// copy читает тело до конца или до паузы дольше stallTimeout, считая байты в общий счётчик.
func (d *downloader) copy(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	var n int64
	buf := make([]byte, 64*1024)
	type readRes struct {
		n   int
		err error
	}
	for {
		ch := make(chan readRes, 1)
		go func() {
			k, err := src.Read(buf)
			ch <- readRes{k, err}
		}()
		var r readRes
		select {
		case r = <-ch:
		case <-time.After(stallTimeout):
			return n, errors.New("нет данных " + stallTimeout.String())
		case <-ctx.Done():
			return n, ctx.Err()
		}
		if r.n > 0 {
			if _, err := dst.Write(buf[:r.n]); err != nil {
				return n, err
			}
			n += int64(r.n)
			d.done.Add(int64(r.n))
		}
		if r.err == io.EOF {
			return n, nil
		}
		if r.err != nil {
			return n, r.err
		}
	}
}

func mb(b int64) string {
	return fmt.Sprintf("%.1f МБ", float64(b)/1024/1024)
}
