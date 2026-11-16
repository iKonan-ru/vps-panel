package eventlog

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Записи journald, которые читает агент: ядро (OOM, ошибки диска), sshd (входы и неудачные
// попытки) и systemd (падения служб, выключение). Остальное системный журнал хранит сам.
var journalMatches = []string{
	"_TRANSPORT=kernel", "+", "SYSLOG_IDENTIFIER=sshd", "+", "SYSLOG_IDENTIFIER=sshd-session", "+", "_PID=1",
}

// journalMaxEntries - за один проход не больше: остальное - в следующих проходах.
const journalMaxEntries = 20_000

// sshTop - адресов с неудачными попытками входа в сводке за час.
const sshTop = 50

var (
	reAccepted = regexp.MustCompile(`^Accepted (\S+) for (\S+) from (\S+) port \d+`)
	reFailed   = regexp.MustCompile(`^Failed (\S+) for (?:invalid user )?(\S*) from (\S+) port \d+`)
	reInvalid  = regexp.MustCompile(`^Invalid user (\S*) from (\S+)`)
	reClosedAu = regexp.MustCompile(`^Connection closed by (?:authenticating|invalid) user (\S*) (\S+) port \d+ \[preauth\]`)
	reMaxAuth  = regexp.MustCompile(`^error: maximum authentication attempts exceeded for (?:invalid user )?(\S*) from (\S+)`)
	reOOM      = regexp.MustCompile(`Out of memory: Killed process (\d+) \(([^)]*)\)`)
	reIOErr    = regexp.MustCompile(`(?i)(I/O error|EXT4-fs error|Buffer I/O error|No space left on device)`)
	reUnitFail = regexp.MustCompile(`^(\S+\.service): Failed with result '([^']+)'`)
	reRestart  = regexp.MustCompile(`^(\S+\.service): Scheduled restart job, restart counter is at (\d+)`)
	reShutdown = regexp.MustCompile(`^Reached target (System Reboot|System Power Off|System Halt|Reboot|Power-Off|Halt)`)
)

type sshFail struct {
	N     int      `json:"n"`
	Users []string `json:"users,omitempty"`
}

// journalState - курсор и то, что нужно для событий, охватывающих несколько записей.
type journalState struct {
	Cursor string `json:"cursor"`
	BootID string `json:"bootId"`
	// LastAt - время последней записи текущей загрузки; Shutdown - видно штатное выключение.
	LastAt   int64 `json:"lastAt"`
	Shutdown bool  `json:"shutdown"`
	// Fails - неудачные входы SSH по часам (unix-час) и адресам.
	Fails map[int64]map[string]*sshFail `json:"fails"`
	// IOAt - когда было последнее событие об ошибке диска (не чаще раза в 10 минут).
	IOAt int64 `json:"ioAt"`
}

// Journal - читатель journald с курсором.
type Journal struct {
	store *Store
	path  string
	st    journalState
	now   func() time.Time
}

// NewJournal - читатель; состояние - в dir/journal.json.
func NewJournal(store *Store, dir string) *Journal {
	j := &Journal{store: store, path: filepath.Join(dir, "journal.json"), now: time.Now}
	loadJSON(j.path, &j.st)
	if j.st.Fails == nil {
		j.st.Fails = map[int64]map[string]*sshFail{}
	}
	return j
}

// Poll - новые записи journald с прошлого курсора (первый раз - за последний час).
func (j *Journal) Poll(ctx context.Context) error {
	if !shell.Has("journalctl") {
		return fmt.Errorf("journalctl нет")
	}
	args := []string{"-o", "json", "--no-pager", "-q",
		"--output-fields=MESSAGE,_BOOT_ID,_TRANSPORT,SYSLOG_IDENTIFIER,_PID"}
	if j.st.Cursor != "" {
		args = append(args, "--after-cursor="+j.st.Cursor)
	} else {
		args = append(args, "--since=-1h")
	}
	args = append(args, journalMatches...)
	res, err := shell.Exec(ctx, 90*time.Second, nil, "journalctl", args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if j.st.Cursor == "" {
			return fmt.Errorf("journalctl: код %d: %s", res.ExitCode, clip(strings.TrimSpace(res.Stderr), 200))
		}
		// журнал только в памяти: после перезагрузки курсора нет - с времени последней записи
		j.st.Cursor = ""
		since := time.UnixMicro(j.st.LastAt).Add(time.Second)
		if j.st.LastAt == 0 {
			since = j.now().Add(-time.Hour)
		}
		for i, a := range args {
			if strings.HasPrefix(a, "--after-cursor=") {
				args[i] = "--since=@" + strconv.FormatInt(since.Unix(), 10)
			}
		}
		if res, err = shell.Exec(ctx, 90*time.Second, nil, "journalctl", args...); err != nil {
			return err
		}
	}
	j.consume([]byte(res.Stdout))
	j.flushFails(false)
	saveJSON(j.path, j.st)
	return nil
}

// Close - выключение агента: неполный час неудачных входов - в буфер сейчас.
func (j *Journal) Close() {
	j.flushFails(true)
	saveJSON(j.path, j.st)
}

func (j *Journal) consume(out []byte) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	n := 0
	for sc.Scan() && n < journalMaxEntries {
		var raw map[string]any
		if json.Unmarshal(sc.Bytes(), &raw) != nil {
			continue
		}
		n++
		str := func(k string) string {
			v, _ := raw[k].(string)
			return v
		}
		if c := str("__CURSOR"); c != "" {
			j.st.Cursor = c
		}
		us, _ := strconv.ParseInt(str("__REALTIME_TIMESTAMP"), 10, 64)
		j.entry(entry{
			at:    time.UnixMicro(us),
			boot:  str("_BOOT_ID"),
			trans: str("_TRANSPORT"),
			ident: str("SYSLOG_IDENTIFIER"),
			pid:   str("_PID"),
			msg:   str("MESSAGE"),
		})
	}
}

type entry struct {
	at                      time.Time
	boot, trans, ident, pid string
	msg                     string
}

// entry - одна запись журнала: событие в буфер или вклад в сводку.
func (j *Journal) entry(e entry) {
	if e.boot != "" && e.boot != j.st.BootID {
		if j.st.BootID != "" {
			prev := time.UnixMicro(j.st.LastAt).UTC()
			text := "Сервер загружен после штатного выключения"
			level := "info"
			if !j.st.Shutdown {
				text = "Сервер загружен без штатного выключения (сбой, перезагрузка хостером или зависание)"
				level = "warn"
			}
			j.store.Add(e.at, "boot", level, text, "", map[string]any{
				"prevLastAt": prev.Format(time.RFC3339), "clean": j.st.Shutdown,
			})
		}
		j.st.BootID, j.st.Shutdown = e.boot, false
	}
	if !e.at.IsZero() {
		j.st.LastAt = e.at.UnixMicro()
	}
	m := strings.TrimSpace(e.msg)
	switch {
	case e.trans == "kernel":
		if g := reOOM.FindStringSubmatch(m); g != nil {
			j.store.Add(e.at, "oom", "error", fmt.Sprintf("Нехватка памяти: ядро завершило процесс %s (%s)", g[2], g[1]),
				"", map[string]any{"pid": g[1], "process": g[2]})
		} else if reIOErr.MatchString(m) && e.at.Unix()-j.st.IOAt >= 600 {
			j.st.IOAt = e.at.Unix()
			j.store.Add(e.at, "disk", "error", "Ошибка диска: "+clip(m, 300), "", nil)
		}
	case e.ident == "sshd" || e.ident == "sshd-session":
		j.ssh(e.at, m)
	case e.pid == "1":
		if g := reUnitFail.FindStringSubmatch(m); g != nil {
			j.store.Add(e.at, "service.failed", "error", fmt.Sprintf("Служба %s упала (%s)", g[1], g[2]),
				"", map[string]any{"unit": g[1], "result": g[2]})
		} else if g := reRestart.FindStringSubmatch(m); g != nil {
			j.store.Add(e.at, "service.restart", "warn", fmt.Sprintf("Служба %s перезапускается (%s-й раз)", g[1], g[2]),
				"", map[string]any{"unit": g[1], "counter": g[2]})
		} else if reShutdown.MatchString(m) {
			j.st.Shutdown = true
			j.store.Add(e.at, "shutdown", "info", "Штатное выключение: "+m, "", nil)
		}
	}
}

func (j *Journal) ssh(at time.Time, m string) {
	if g := reAccepted.FindStringSubmatch(m); g != nil {
		j.store.Add(at, "ssh.login", "info", fmt.Sprintf("Вход по SSH: %s с %s (%s)", g[2], g[3], g[1]), g[3],
			map[string]any{"user": g[2], "method": g[1]})
		return
	}
	var user, ip string
	if g := reFailed.FindStringSubmatch(m); g != nil {
		user, ip = g[2], g[3]
	} else if g := reInvalid.FindStringSubmatch(m); g != nil {
		user, ip = g[1], g[2]
	} else if g := reClosedAu.FindStringSubmatch(m); g != nil {
		user, ip = g[1], g[2]
	} else if g := reMaxAuth.FindStringSubmatch(m); g != nil {
		user, ip = g[1], g[2]
	} else {
		return
	}
	h := at.Unix() / 3600
	byIP := j.st.Fails[h]
	if byIP == nil {
		byIP = map[string]*sshFail{}
		j.st.Fails[h] = byIP
	}
	f := byIP[ip]
	if f == nil {
		f = &sshFail{}
		byIP[ip] = f
	}
	f.N++
	if user != "" && len(f.Users) < 5 && !contains(f.Users, user) {
		f.Users = append(f.Users, user)
	}
}

// flushFails - сводки неудачных входов SSH за прошедшие часы (all - и за текущий).
func (j *Journal) flushFails(all bool) {
	cur := j.now().Unix() / 3600
	for h, byIP := range j.st.Fails {
		if h >= cur && !all {
			continue
		}
		delete(j.st.Fails, h)
		if len(byIP) == 0 {
			continue
		}
		type row struct {
			IP    string   `json:"ip"`
			N     int      `json:"n"`
			Users []string `json:"users,omitempty"`
		}
		rows := make([]row, 0, len(byIP))
		total := 0
		for ip, f := range byIP {
			rows = append(rows, row{ip, f.N, f.Users})
			total += f.N
		}
		sort.Slice(rows, func(a, b int) bool { return rows[a].N > rows[b].N || rows[a].N == rows[b].N && rows[a].IP < rows[b].IP })
		addrs := len(rows)
		if len(rows) > sshTop {
			rows = rows[:sshTop]
		}
		j.store.Add(time.Unix(h*3600, 0), "ssh.failed", "info",
			fmt.Sprintf("SSH: %d неудачных попыток входа с %d адресов за час", total, addrs), "",
			map[string]any{"total": total, "addrs": addrs, "top": rows})
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
