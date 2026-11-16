package eventlog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStorePullAckEpochOverflow(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		s.Add(time.Time{}, "metric", "info", "", "", map[string]int{"i": i})
	}
	r := s.Pull("", 0, 10)
	if len(r.Events) != 2 || r.Events[0].Seq != 1 || r.Epoch == "" {
		t.Fatalf("первый забор: %+v", r)
	}
	// подтверждение первого - он удаляется; буфер переживает перезапуск
	r = s.Pull(r.Epoch, 1, 10)
	if len(r.Events) != 1 || r.Events[0].Seq != 2 {
		t.Fatalf("после подтверждения: %+v", r.Events)
	}
	s2, err := Open(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Len() != 1 {
		t.Fatalf("после перезапуска событий %d", s2.Len())
	}
	// переполнение: старые теряются, панель узнаёт сколько
	for i := 0; i < 4; i++ {
		s2.Add(time.Time{}, "metric", "info", "", "", nil)
	}
	r = s2.Pull(r.Epoch, 2, 10)
	if r.Dropped != 2 || len(r.Events) != 3 || r.Events[0].Seq != 4 {
		t.Fatalf("переполнение: dropped=%d %+v", r.Dropped, r.Events)
	}
	// чужая эпоха (агент переустановлен) - с начала
	r = s2.Pull("other", 100, 10)
	if len(r.Events) != 3 {
		t.Fatalf("чужая эпоха: %d", len(r.Events))
	}
}

func kinds(s *Store) []string {
	var out []string
	for _, e := range s.Pull("", 0, 100).Events {
		out = append(out, e.Kind)
	}
	return out
}

func TestJournalEvents(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 1000)
	j := NewJournal(s, dir)
	now := time.Date(2026, 11, 16, 12, 30, 0, 0, time.UTC)
	j.now = func() time.Time { return now }
	at := now.Add(-2 * time.Hour)
	e := func(boot, trans, ident, pid, msg string) {
		j.entry(entry{at: at, boot: boot, trans: trans, ident: ident, pid: pid, msg: msg})
		at = at.Add(time.Second)
	}
	e("b1", "syslog", "sshd", "100", "Failed password for invalid user admin from 203.0.113.9 port 4000 ssh2")
	e("b1", "syslog", "sshd", "100", "Invalid user test from 203.0.113.9 port 4001")
	e("b1", "syslog", "sshd", "100", "Accepted publickey for root from 198.51.100.4 port 5000 ssh2: ED25519")
	e("b1", "kernel", "kernel", "", "Out of memory: Killed process 1234 (xray) total-vm:100kB")
	e("b1", "journal", "systemd", "1", "x-ui.service: Failed with result 'exit-code'.")
	// перезагрузка без штатного выключения
	e("b2", "kernel", "kernel", "", "Linux version 6.8")
	e("b2", "journal", "systemd", "1", "Reached target System Reboot.")
	e("b3", "kernel", "kernel", "", "Linux version 6.8")
	j.flushFails(false)
	got := strings.Join(kinds(s), ",")
	want := "ssh.login,oom,service.failed,boot,shutdown,boot,ssh.failed"
	if got != want {
		t.Fatalf("события %s, ждали %s", got, want)
	}
}

func TestJournalBootLevels(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 1000)
	j := NewJournal(s, dir)
	at := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	j.entry(entry{at: at, boot: "a", trans: "kernel", msg: "x"})
	j.entry(entry{at: at.Add(time.Minute), boot: "b", trans: "kernel", msg: "x"})
	ev := s.Pull("", 0, 10).Events
	if len(ev) != 1 || ev[0].Level != "warn" {
		t.Fatalf("загрузка без выключения: %+v", ev)
	}
	var d map[string]any
	_ = json.Unmarshal(ev[0].Data, &d)
	if d["clean"] != false || d["prevLastAt"] != "2026-11-16T10:00:00Z" {
		t.Fatalf("данные: %v", d)
	}
}

func TestParseAccess(t *testing.T) {
	l, ok := ParseAccess("2026/11/16 17:40:01.123456 from tcp:198.51.100.7:51234 accepted tcp:example.com:443 [in-443 >> direct] email: anna", time.UTC)
	if !ok || l.From != "198.51.100.7" || l.Host != "example.com" || l.Port != 443 || l.Outbound != "direct" || l.Email != "anna" || l.Net != "tcp" {
		t.Fatalf("строка: %+v %v", l, ok)
	}
	l, ok = ParseAccess("2026/11/16 17:40:02 from 198.51.100.7:1 rejected udp:203.0.113.1:53 [in -> block] email: bob", time.UTC)
	if !ok || l.Outbound != "rejected" || l.Net != "udp" || l.Inbound != "in" {
		t.Fatalf("отклонённая: %+v %v", l, ok)
	}
	if _, ok := ParseAccess("2026/11/16 17:40:02 [Warning] something", time.UTC); ok {
		t.Fatal("не строка доступа")
	}
}

func TestAccessPoll(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "access.log")
	if err := os.WriteFile(logPath, []byte("2026/11/16 10:00:00 from 1.1.1.1:1 accepted tcp:old.example:443 [a >> direct] email: anna\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := Open(dir, 1000)
	a := NewAccess(s, dir)
	a.loc = time.UTC
	a.pathFn = func() string { return logPath }
	// первый проход - с конца файла: старое не берём
	a.Poll()
	if s.Len() != 0 || !a.Status().Enabled {
		t.Fatalf("первый проход: %d %+v", s.Len(), a.Status())
	}
	f, _ := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0)
	for i := 0; i < 3; i++ {
		_, _ = f.WriteString("2026/11/16 11:05:00 from 1.1.1.1:1 accepted tcp:example.com:443 [a >> direct] email: anna\n")
	}
	_, _ = f.WriteString("2026/11/16 11:06:00 from 1.1.1.1:1 accepted tcp:other.example:80 [a >> direct] email: anna\n")
	_, _ = f.WriteString("2026/11/16 11:07:00 from 1.1.1.1:1 accepted tcp:half") // неполная строка
	_ = f.Close()
	a.Poll()
	r := s.Pull("", 0, 10)
	ev := r.Events
	if len(ev) != 1 || ev[0].Kind != "dest" {
		t.Fatalf("сводка: %+v", ev)
	}
	var d struct {
		Hour string    `json:"hour"`
		Rows []DestRow `json:"rows"`
	}
	_ = json.Unmarshal(ev[0].Data, &d)
	if d.Hour != "2026-11-16T11:00:00Z" || len(d.Rows) != 2 || d.Rows[0].Host != "example.com" || d.Rows[0].N != 3 {
		t.Fatalf("строки: %+v", d)
	}
	// дописанный хвост неполной строки дочитывается
	f, _ = os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(".example:443 [a >> direct] email: anna\n")
	_ = f.Close()
	a.Poll()
	ev = s.Pull(r.Epoch, ev[0].Seq, 10).Events
	if len(ev) != 1 {
		t.Fatalf("хвост: %+v", ev)
	}
}
