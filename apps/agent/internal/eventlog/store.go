// Package eventlog - журнал сервера на стороне агента: системный журнал, нагрузка по минутам и
// назначения клиентов xray копятся в буфере на диске и забираются панелью (events.pull), в том
// числе за время, пока панель была недоступна.
package eventlog

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultDir - каталог состояния журнала (удаляется вместе с агентом).
const DefaultDir = "/etc/vps-agent/events"

// DefaultMax - сколько событий держит буфер; лишние - самые старые - теряются (счётчик dropped).
const DefaultMax = 50_000

// Event - запись буфера. Seq растёт на единицу и не повторяется в пределах Epoch.
type Event struct {
	Seq   int64           `json:"seq"`
	At    string          `json:"at"`
	Kind  string          `json:"kind"`
	Level string          `json:"level"`
	Text  string          `json:"text,omitempty"`
	IP    string          `json:"ip,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// Store - буфер событий: в памяти и строками JSON в файле (переживает перезапуск агента).
type Store struct {
	mu      sync.Mutex
	dir     string
	max     int
	epoch   string
	seq     int64
	events  []Event
	dropped int64
	now     func() time.Time
}

// PullResult - ответ events.pull.
type PullResult struct {
	Epoch  string  `json:"epoch"`
	Events []Event `json:"events"`
	// Dropped - сколько событий потеряно из-за переполнения буфера с прошлого забора.
	Dropped int64 `json:"dropped"`
	More    bool  `json:"more"`
	// Access - журнал доступа xray: включён ли и откуда читается.
	Access AccessStatus `json:"access"`
}

// Open читает буфер из dir (создаёт каталог). Epoch - случайный при первом запуске: панель
// по нему узнаёт, что буфер начат заново (переустановка агента), и забирает с начала.
func Open(dir string, max int) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, max: max, now: time.Now}
	b, err := os.ReadFile(filepath.Join(dir, "epoch"))
	if err == nil && len(strings.TrimSpace(string(b))) > 0 {
		s.epoch = strings.TrimSpace(string(b))
	} else {
		r := make([]byte, 8)
		_, _ = rand.Read(r)
		s.epoch = hex.EncodeToString(r)
		if err := os.WriteFile(filepath.Join(dir, "epoch"), []byte(s.epoch+"\n"), 0o600); err != nil {
			return nil, err
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "seq")); err == nil {
		var n int64
		if json.Unmarshal([]byte(strings.TrimSpace(string(b))), &n) == nil {
			s.seq = n
		}
	}
	if f, err := os.Open(s.file()); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
		for sc.Scan() {
			var e Event
			if json.Unmarshal(sc.Bytes(), &e) == nil && e.Seq > 0 {
				s.events = append(s.events, e)
				if e.Seq > s.seq {
					s.seq = e.Seq
				}
			}
		}
		_ = f.Close()
	}
	return s, nil
}

func (s *Store) file() string { return filepath.Join(s.dir, "events.jsonl") }

// Add дописывает событие; at пустое - сейчас.
func (s *Store) Add(at time.Time, kind, level, text, ip string, data any) {
	var raw json.RawMessage
	if data != nil {
		if b, err := json.Marshal(data); err == nil {
			raw = b
		}
	}
	if at.IsZero() {
		at = s.now()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	e := Event{Seq: s.seq, At: at.UTC().Format(time.RFC3339Nano), Kind: kind, Level: level, Text: text, IP: ip, Data: raw}
	s.events = append(s.events, e)
	_ = os.WriteFile(filepath.Join(s.dir, "seq"), []byte(jsonInt(s.seq)), 0o600)
	if over := len(s.events) - s.max; over > 0 {
		s.dropped += int64(over)
		s.events = append([]Event(nil), s.events[over:]...)
		s.rewrite()
		return
	}
	if f, err := os.OpenFile(s.file(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		if b, err := json.Marshal(e); err == nil {
			_, _ = f.Write(append(b, '\n'))
		}
		_ = f.Close()
	}
}

// Pull: события после after (они подтверждены и удаляются), не больше limit.
func (s *Store) Pull(epoch string, after int64, limit int) PullResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch != s.epoch {
		after = 0
	}
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	i := 0
	for i < len(s.events) && s.events[i].Seq <= after {
		i++
	}
	if i > 0 {
		s.events = append([]Event(nil), s.events[i:]...)
		s.rewrite()
	}
	n := min(limit, len(s.events))
	out := PullResult{Epoch: s.epoch, Events: append([]Event{}, s.events[:n]...), Dropped: s.dropped, More: n < len(s.events)}
	s.dropped = 0
	return out
}

// rewrite - файл буфера заново (после удаления подтверждённых или старых): через временный.
func (s *Store) rewrite() {
	tmp := s.file() + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	w := bufio.NewWriter(f)
	for _, e := range s.events {
		if b, err := json.Marshal(e); err == nil {
			_, _ = w.Write(append(b, '\n'))
		}
	}
	if w.Flush() != nil || f.Close() != nil {
		_ = os.Remove(tmp)
		return
	}
	_ = os.Rename(tmp, s.file())
}

// Len - событий в буфере.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.events)
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// saveJSON - состояние читателя (курсор журнала, смещение в журнале доступа) через временный файл.
func saveJSON(path string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func loadJSON(path string, v any) {
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, v)
	}
}
