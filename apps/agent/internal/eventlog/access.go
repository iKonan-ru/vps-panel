package eventlog

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// XuiBinDir - каталог xray из 3X-UI с config.json (переменная - для тестов).
var XuiBinDir = "/usr/local/x-ui/bin"

const (
	// accessReadMax - за один проход журнала доступа читается не больше.
	accessReadMax = 64 << 20
	// accessTruncateAt - журнал доступа больше этого обрезается агентом после чтения: xray пишет
	// его без ротации, а агент уже забрал прочитанное.
	accessTruncateAt = 128 << 20
	// destPerEvent - строк сводки в одном событии; больше - несколькими событиями.
	destPerEvent = 2000
	// destPerUser - разных назначений пользователя за час; остальное - строкой "*".
	destPerUser = 300
)

// AccessStatus - журнал доступа xray: включён ли (путь в config.json) и ошибка чтения.
type AccessStatus struct {
	Enabled bool   `json:"enabled"`
	Path    string `json:"path,omitempty"`
	Error   string `json:"error,omitempty"`
}

// 2026/11/16 17:40:01.123456 from tcp:198.51.100.7:51234 accepted tcp:example.com:443 [in-443 >> direct] email: user
var reAccess = regexp.MustCompile(`^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)? from (?:(?:tcp|udp):)?(\S+?):\d+ (accepted|rejected) (?:(tcp|udp):)?(\S+):(\d+)(?: \[([^\]]*)\])?(?: email: (\S+))?`)

// AccessLine - разобранная строка журнала доступа.
type AccessLine struct {
	At       time.Time
	From     string
	Rejected bool
	Net      string
	Host     string
	Port     int
	Inbound  string
	Outbound string
	Email    string
}

// ParseAccess - строка журнала доступа xray; не та строка - false.
func ParseAccess(line string, loc *time.Location) (AccessLine, bool) {
	g := reAccess.FindStringSubmatch(line)
	if g == nil {
		return AccessLine{}, false
	}
	at, err := time.ParseInLocation("2006/01/02 15:04:05", g[1], loc)
	if err != nil {
		return AccessLine{}, false
	}
	port, _ := strconv.Atoi(g[6])
	l := AccessLine{At: at, From: strings.Trim(g[2], "[]"), Rejected: g[3] == "rejected", Net: g[4], Host: g[5], Port: port, Email: g[8]}
	if l.Net == "" {
		l.Net = "tcp"
	}
	if route := g[7]; route != "" {
		sep := " >> "
		if !strings.Contains(route, sep) {
			sep = " -> "
		}
		in, out, _ := strings.Cut(route, sep)
		l.Inbound, l.Outbound = strings.TrimSpace(in), strings.TrimSpace(out)
	}
	if l.Rejected {
		l.Outbound = "rejected"
	}
	return l, true
}

// AccessLogPath - путь журнала доступа из config.json xray 3X-UI; пусто - выключен.
func AccessLogPath() string {
	b, err := os.ReadFile(filepath.Join(XuiBinDir, "config.json"))
	if err != nil {
		return ""
	}
	var c struct {
		Log struct {
			Access string `json:"access"`
		} `json:"log"`
	}
	if json.Unmarshal(b, &c) != nil {
		return ""
	}
	p := strings.TrimSpace(c.Log.Access)
	if p == "" || strings.EqualFold(p, "none") {
		return ""
	}
	if !filepath.IsAbs(p) {
		// xray 3X-UI запускается из каталога bin; запасной вариант - каталог 3X-UI
		if cand := filepath.Join(XuiBinDir, p); exists(cand) {
			return cand
		}
		return filepath.Join(filepath.Dir(XuiBinDir), p)
	}
	return p
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

type destKey struct {
	Email, Host, Net, Out string
	Port                  int
}

type accessState struct {
	Path   string `json:"path"`
	Inode  uint64 `json:"inode"`
	Offset int64  `json:"offset"`
}

// Access - читатель журнала доступа xray: сводка "пользователь -> назначение -> число запросов"
// по часам. Каждый проход кладёт в буфер прирост с прошлого прохода (панель складывает).
type Access struct {
	store  *Store
	path   string
	st     accessState
	mu     sync.Mutex
	status AccessStatus
	loc    *time.Location
	pathFn func() string
}

// NewAccess - читатель; состояние - в dir/access.json.
func NewAccess(store *Store, dir string) *Access {
	a := &Access{store: store, path: filepath.Join(dir, "access.json"), loc: time.Local, pathFn: AccessLogPath}
	loadJSON(a.path, &a.st)
	return a
}

// Status - последнее состояние журнала доступа.
func (a *Access) Status() AccessStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.status
}

func (a *Access) setStatus(s AccessStatus) {
	a.mu.Lock()
	a.status = s
	a.mu.Unlock()
}

// Poll - новые строки журнала доступа с прошлого смещения.
func (a *Access) Poll() {
	p := a.pathFn()
	st := AccessStatus{Enabled: p != "", Path: p}
	defer func() { a.setStatus(st) }()
	if p == "" {
		return
	}
	f, err := os.Open(p)
	if err != nil {
		if !os.IsNotExist(err) {
			st.Error = err.Error()
		}
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		st.Error = err.Error()
		return
	}
	var ino uint64
	if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
		ino = sys.Ino
	}
	// другой файл, обрезан или впервые - с начала (впервые - с конца: старое не нужно)
	if a.st.Path != p || a.st.Inode != ino || fi.Size() < a.st.Offset {
		first := a.st.Path == ""
		a.st = accessState{Path: p, Inode: ino}
		if first {
			a.st.Offset = fi.Size()
		}
	}
	if _, err := f.Seek(a.st.Offset, io.SeekStart); err != nil {
		st.Error = err.Error()
		return
	}
	agg := map[int64]map[destKey]int{}
	perUser := map[int64]map[string]int{}
	r := bufio.NewReaderSize(io.LimitReader(f, accessReadMax), 256*1024)
	var read int64
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			// неполная последняя строка - дочитается в следующий раз
			break
		}
		read += int64(len(line))
		l, ok := ParseAccess(strings.TrimRight(line, "\r\n"), a.loc)
		if !ok {
			continue
		}
		h := l.At.Unix() / 3600
		if agg[h] == nil {
			agg[h] = map[destKey]int{}
			perUser[h] = map[string]int{}
		}
		k := destKey{Email: l.Email, Host: l.Host, Net: l.Net, Out: l.Outbound, Port: l.Port}
		if _, seen := agg[h][k]; !seen {
			if perUser[h][l.Email] >= destPerUser {
				k = destKey{Email: l.Email, Host: "*", Net: l.Net, Out: l.Outbound}
			} else {
				perUser[h][l.Email]++
			}
		}
		agg[h][k]++
	}
	a.st.Offset += read
	a.emit(agg)
	if a.st.Offset >= fi.Size() && fi.Size() > accessTruncateAt {
		if os.Truncate(p, 0) == nil {
			a.st.Offset = 0
		}
	}
	saveJSON(a.path, a.st)
}

// DestRow - строка сводки назначений.
type DestRow struct {
	Email string `json:"email"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
	Net   string `json:"net"`
	Out   string `json:"out"`
	N     int    `json:"n"`
}

func (a *Access) emit(agg map[int64]map[destKey]int) {
	hours := make([]int64, 0, len(agg))
	for h := range agg {
		hours = append(hours, h)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i] < hours[j] })
	for _, h := range hours {
		rows := make([]DestRow, 0, len(agg[h]))
		for k, n := range agg[h] {
			rows = append(rows, DestRow{k.Email, k.Host, k.Port, k.Net, k.Out, n})
		}
		sort.Slice(rows, func(i, j int) bool {
			if rows[i].Email != rows[j].Email {
				return rows[i].Email < rows[j].Email
			}
			return rows[i].N > rows[j].N
		})
		at := time.Unix(h*3600, 0)
		for len(rows) > 0 {
			n := min(destPerEvent, len(rows))
			a.store.Add(at, "dest", "info", "", "", map[string]any{"hour": at.UTC().Format(time.RFC3339), "rows": rows[:n]})
			rows = rows[n:]
		}
	}
}
