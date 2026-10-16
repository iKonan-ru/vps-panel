// Package cleanup - поиск и удаление мусора на диске: кэш сборки docker, неиспользуемые образы,
// остановленные контейнеры, кэш apt, старый journal, ротированные логи, старые файлы в /tmp.
// Ничего из данных сервисов (тома, конфиги, базы) не трогается.
package cleanup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Item - категория мусора: сколько занимает и как чистится.
type Item struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Bytes  int64  `json:"bytes"`
	// Safe: удаление ничего не ломает; false - предупреждение в интерфейсе.
	Safe bool `json:"safe"`
}

// Scan - список категорий с размерами; нулевые не возвращаются.
func Scan(ctx context.Context) ([]Item, error) {
	var out []Item
	add := func(it Item) {
		if it.Bytes > 0 {
			out = append(out, it)
		}
	}
	if shell.Has("docker") {
		bc, di, ui, sc, _ := dockerUsage(ctx)
		add(Item{ID: "docker-build-cache", Title: "Кэш сборки docker", Detail: "слои buildkit от старых сборок; следующая сборка будет дольше", Bytes: bc, Safe: true})
		add(Item{ID: "docker-dangling", Title: "Безымянные образы docker", Detail: "слои <none>, оставшиеся после пересборок", Bytes: di, Safe: true})
		add(Item{ID: "docker-unused-images", Title: "Неиспользуемые образы docker", Detail: "образы без запущенных контейнеров (кроме node и alpine для сборки панели); при следующем запуске скачаются заново", Bytes: ui, Safe: false})
		add(Item{ID: "docker-stopped", Title: "Остановленные контейнеры", Detail: "контейнеры exited и created вместе со слоем записи", Bytes: sc, Safe: false})
	}
	add(Item{ID: "apt-cache", Title: "Кэш пакетов apt", Detail: "/var/cache/apt: скачанные .deb", Bytes: dirSize("/var/cache/apt"), Safe: true})
	add(Item{ID: "apt-lists", Title: "Индексы репозиториев apt", Detail: "/var/lib/apt/lists: пересоздаются при apt-get update", Bytes: dirSize("/var/lib/apt/lists"), Safe: true})
	if j := journalSize(ctx); j > 64<<20 {
		add(Item{ID: "journal", Title: "Журнал systemd старше 7\u00a0дней", Detail: fmt.Sprintf("журнал сейчас занимает %s", human(j)), Bytes: j - 64<<20, Safe: true})
	}
	add(Item{ID: "logs-rotated", Title: "Ротированные логи", Detail: "/var/log/*.1, *.gz, *.old; текущие логи не трогаются", Bytes: rotatedLogsSize(), Safe: true})
	add(Item{ID: "tmp-old", Title: "Файлы в /tmp и /var/tmp старше 7\u00a0дней", Detail: "к ним неделю никто не обращался", Bytes: oldTmpSize(7 * 24 * time.Hour), Safe: true})
	sort.Slice(out, func(i, j int) bool { return out[i].Bytes > out[j].Bytes })
	if out == nil {
		out = []Item{}
	}
	return out, nil
}

// Run чистит выбранные категории, пишет ход в stream; возвращает освобождённые байты по df.
func Run(ctx context.Context, ids []string, stream func(channel, chunk string)) (map[string]any, error) {
	before := diskFree()
	log := func(s string) { stream("stdout", s+"\n") }
	for _, id := range ids {
		switch id {
		case "docker-build-cache":
			log("== кэш сборки docker")
			run(ctx, stream, "docker", "builder", "prune", "-af")
		case "docker-dangling":
			log("== безымянные образы")
			run(ctx, stream, "docker", "image", "prune", "-f")
		case "docker-unused-images":
			log("== неиспользуемые образы")
			_, _, _, _, ids := dockerUsage(ctx)
			if len(ids) == 0 {
				log("нечего удалять")
			} else {
				run(ctx, stream, "docker", append([]string{"rmi"}, ids...)...)
			}
		case "docker-stopped":
			log("== остановленные контейнеры")
			run(ctx, stream, "docker", "container", "prune", "-f")
		case "apt-cache":
			log("== кэш apt")
			run(ctx, stream, "apt-get", "clean")
		case "apt-lists":
			log("== индексы apt")
			_ = removeChildren("/var/lib/apt/lists", func(string, os.FileInfo) bool { return true })
			log("удалено /var/lib/apt/lists/*; apt-get update пересоздаст")
		case "journal":
			log("== journal")
			run(ctx, stream, "journalctl", "--vacuum-time=7d")
		case "logs-rotated":
			log("== ротированные логи")
			n := removeChildren("/var/log", func(p string, fi os.FileInfo) bool { return isRotatedLog(p) })
			log(fmt.Sprintf("удалено файлов: %d", n))
		case "tmp-old":
			log("== /tmp и /var/tmp старше 7 дней")
			n := 0
			for _, d := range []string{"/tmp", "/var/tmp"} {
				n += removeChildren(d, func(p string, fi os.FileInfo) bool {
					return oldTmp(p, fi, 7*24*time.Hour)
				})
			}
			log(fmt.Sprintf("удалено: %d", n))
		default:
			log("неизвестная категория: " + id)
		}
	}
	after := diskFree()
	freed := after - before
	if freed < 0 {
		freed = 0
	}
	log(fmt.Sprintf("Освобождено: %s, свободно теперь %s", human(freed), human(after)))
	return map[string]any{"freedBytes": freed, "freeBytes": after}, nil
}

func run(ctx context.Context, stream func(channel, chunk string), name string, args ...string) {
	res, err := shell.Exec(ctx, 10*time.Minute, stream, name, args...)
	if err != nil {
		stream("stderr", err.Error()+"\n")
		return
	}
	if res.ExitCode != 0 {
		stream("stderr", fmt.Sprintf("%s завершился с кодом %d\n", name, res.ExitCode))
	}
}

// keepImages - базовые образы для сборки панели: Docker Hub из РФ бывает недоступен, удалять их
// нельзя, хотя контейнеров на них нет.
var keepImages = regexp.MustCompile(`^(node|alpine)$`)

// dockerUsage - кэш сборки, безымянные образы, неиспользуемые образы (и их id для удаления),
// остановленные контейнеры.
func dockerUsage(ctx context.Context) (build, dangling, unused, stopped int64, unusedIDs []string) {
	// docker system df --format json: по строке на тип, Reclaimable вида "20.13GB (100%)"
	out := shell.Out(ctx, "docker", "system", "df", "--format", "{{json .}}")
	for _, line := range strings.Split(out, "\n") {
		var row struct {
			Type        string `json:"Type"`
			Reclaimable string `json:"Reclaimable"`
		}
		if json.Unmarshal([]byte(line), &row) != nil {
			continue
		}
		v := parseHuman(strings.Fields(row.Reclaimable)[0])
		switch row.Type {
		case "Build Cache":
			build = v
		case "Containers":
			stopped = v
		}
	}
	// образы: dangling отдельно от просто неиспользуемых
	// id образов контейнеров берём через inspect (полный sha256), images даёт короткий id:
	// сравниваем по первым 12 символам
	short := func(id string) string {
		id = strings.TrimPrefix(id, "sha256:")
		if len(id) > 12 {
			id = id[:12]
		}
		return id
	}
	used := map[string]bool{}
	if cids := strings.Fields(shell.Out(ctx, "docker", "ps", "-aq")); len(cids) > 0 {
		args := append([]string{"inspect", "--format", "{{.Image}}"}, cids...)
		for _, id := range strings.Fields(shell.Out(ctx, "docker", args...)) {
			used[short(id)] = true
		}
	}
	for _, line := range strings.Split(shell.Out(ctx, "docker", "images", "--format", "{{.ID}}\t{{.Repository}}\t{{.Size}}"), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 3 || used[short(f[0])] {
			continue
		}
		if f[1] == "<none>" {
			dangling += parseHuman(f[2])
		} else if !keepImages.MatchString(f[1]) {
			unused += parseHuman(f[2])
			unusedIDs = append(unusedIDs, f[0])
		}
	}
	return
}

var reHuman = regexp.MustCompile(`^([0-9.]+)\s*([kKMGT]?i?B?)$`)

func parseHuman(s string) int64 {
	m := reHuman.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0
	}
	v, _ := strconv.ParseFloat(m[1], 64)
	mult := float64(1)
	switch strings.ToUpper(strings.TrimSuffix(strings.TrimSuffix(m[2], "B"), "i")) {
	case "K":
		mult = 1e3
	case "M":
		mult = 1e6
	case "G":
		mult = 1e9
	case "T":
		mult = 1e12
	}
	return int64(v * mult)
}

func human(b int64) string {
	switch {
	case b >= 1<<30:
		return strings.Replace(fmt.Sprintf("%.1f", float64(b)/(1<<30)), ".", ",", 1) + "\u00a0ГБ"
	case b >= 1<<20:
		return fmt.Sprintf("%.0f\u00a0МБ", float64(b)/(1<<20))
	default:
		return fmt.Sprintf("%d\u00a0КБ", b/1024)
	}
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			n += fi.Size()
		}
		return nil
	})
	return n
}

func journalSize(ctx context.Context) int64 {
	var n int64
	_ = filepath.Walk("/var/log/journal", func(_ string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			n += fi.Size()
		}
		return nil
	})
	return n
}

var reRotated = regexp.MustCompile(`(\.[0-9]+|\.gz|\.xz|\.old|\.[0-9]+\.log)$`)

func isRotatedLog(p string) bool {
	return reRotated.MatchString(filepath.Base(p)) && !strings.Contains(p, "/journal/")
}

func rotatedLogsSize() int64 {
	var n int64
	_ = filepath.Walk("/var/log", func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() && isRotatedLog(p) {
			n += fi.Size()
		}
		return nil
	})
	return n
}

// tmpKeep - то, чем в /tmp пользуются работающие службы: PrivateTmp systemd, сессии tmux, сокеты
// X11. Время самого каталога не говорит, пользуются ли им (служба может работать месяцами).
var tmpKeep = []string{"vps-agent", "systemd-private-", "snap-private-tmp", "tmux-",
	".X11-unix", ".ICE-unix", ".XIM-unix", ".font-unix", ".Test-unix"}

// oldTmp - запись верхнего уровня /tmp, к которой давно никто не обращался: файл старше age или
// каталог, в котором ничего не свежее age (время самого каталога о содержимом не говорит).
func oldTmp(p string, fi os.FileInfo, age time.Duration) bool {
	name := filepath.Base(p)
	for _, k := range tmpKeep {
		if strings.HasPrefix(name, k) {
			return false
		}
	}
	if (!fi.Mode().IsRegular() && !fi.IsDir()) || time.Since(fi.ModTime()) < age {
		return false
	}
	if !fi.IsDir() {
		return true
	}
	fresh := false
	_ = filepath.Walk(p, func(_ string, f os.FileInfo, err error) error {
		if err == nil && time.Since(f.ModTime()) < age {
			fresh = true
			return filepath.SkipAll
		}
		return nil
	})
	return !fresh
}

func oldTmpSize(age time.Duration) int64 {
	var n int64
	for _, d := range []string{"/tmp", "/var/tmp"} {
		entries, _ := os.ReadDir(d)
		for _, e := range entries {
			p := filepath.Join(d, e.Name())
			fi, err := os.Lstat(p)
			if err != nil || !oldTmp(p, fi, age) {
				continue
			}
			if fi.IsDir() {
				n += dirSize(p)
			} else {
				n += fi.Size()
			}
		}
	}
	return n
}

// removeChildren удаляет записи верхнего уровня каталога, для которых keep-функция вернула true.
func removeChildren(dir string, match func(string, os.FileInfo) bool) int {
	n := 0
	if dir == "/var/log" {
		// логи лежат и в подкаталогах (apt/, nginx/), поэтому обходим рекурсивно только файлы
		_ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
			if err == nil && fi.Mode().IsRegular() && match(p, fi) {
				if os.Remove(p) == nil {
					n++
				}
			}
			return nil
		})
		return n
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		fi, err := os.Lstat(p)
		if err != nil || !match(p, fi) {
			continue
		}
		if os.RemoveAll(p) == nil {
			n++
		}
	}
	return n
}

// diskFree - свободно на корневом разделе для обычных процессов (как avail у df).
func diskFree() int64 {
	var st syscall.Statfs_t
	if syscall.Statfs("/", &st) != nil {
		return 0
	}
	return int64(st.Bavail) * st.Bsize
}
