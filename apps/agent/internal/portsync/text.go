package portsync

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	reLabelJunk = regexp.MustCompile(`[^\p{L}\p{N}_ .:/-]+`)
	reSpaces    = regexp.MustCompile(`\s+`)
)

// labelText - подпись сервиса для комментария правила: буквы (и кириллица), цифры, пробел и
// - _ . : /, без кавычек и эмодзи (флаги в имени inbound-а 3X-UI), не длиннее limit символов.
func labelText(s string, limit int) string {
	s = reLabelJunk.ReplaceAllString(s, " ")
	s = strings.TrimSpace(reSpaces.ReplaceAllString(s, " "))
	if r := []rune(s); len(r) > limit {
		s = string(r[:limit])
	}
	return strings.TrimSpace(s)
}

// fnmatch - совпадение имени с шаблоном, как fnmatch в Python: * - любые символы, ? - один,
// [abc] и [!abc] - набор.
func fnmatch(name, pat string) bool {
	re, err := regexp.Compile(translate(pat))
	return err == nil && re.MatchString(name)
}

func translate(pat string) string {
	var b strings.Builder
	b.WriteString(`(?s)^`)
	r := []rune(pat)
	for i := 0; i < len(r); i++ {
		switch c := r[i]; c {
		case '*':
			b.WriteString(`.*`)
		case '?':
			b.WriteString(`.`)
		case '[':
			j := i + 1
			if j < len(r) && r[j] == '!' {
				j++
			}
			if j < len(r) && r[j] == ']' {
				j++
			}
			for j < len(r) && r[j] != ']' {
				j++
			}
			if j >= len(r) {
				b.WriteString(`\[`)
				continue
			}
			set := string(r[i+1 : j])
			i = j
			neg := strings.HasPrefix(set, "!")
			set = strings.TrimPrefix(set, "!")
			set = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `^`, `\^`).Replace(set)
			if neg {
				b.WriteString(`[^` + set + `]`)
			} else {
				b.WriteString(`[` + set + `]`)
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString(`$`)
	return b.String()
}

// node - значение JSON с порядком ключей объекта (как dict в Python).
type node struct {
	keys []string
	vals []*node
	list []*node
	obj  bool
	arr  bool
	v    any // json.Number, string, bool, nil
}

func parseOrdered(dec *json.Decoder) (*node, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch d := t.(type) {
	case json.Delim:
		n := &node{obj: d == '{', arr: d == '['}
		for dec.More() {
			if n.obj {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				v, err := parseOrdered(dec)
				if err != nil {
					return nil, err
				}
				// повтор ключа: место первого, значение последнего
				dup := false
				for i, old := range n.keys {
					if old == k {
						n.vals[i], dup = v, true
					}
				}
				if !dup {
					n.keys, n.vals = append(n.keys, k), append(n.vals, v)
				}
			} else {
				v, err := parseOrdered(dec)
				if err != nil {
					return nil, err
				}
				n.list = append(n.list, v)
			}
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return n, nil
	default:
		return &node{v: t}, nil
	}
}

// truthy - истинность значения, как в Python.
func (n *node) truthy() bool {
	switch {
	case n == nil:
		return false
	case n.obj:
		return len(n.keys) > 0
	case n.arr:
		return len(n.list) > 0
	}
	switch v := n.v.(type) {
	case json.Number:
		f, err := v.Float64()
		return err != nil || f != 0
	case string:
		return v != ""
	case bool:
		return v
	}
	return false
}

// dig - значение ключа key: в объекте сразу, иначе первое истинное в глубину.
func (n *node) dig(key string) *node {
	switch {
	case n.obj:
		for i, k := range n.keys {
			if k == key {
				return n.vals[i]
			}
		}
		for _, v := range n.vals {
			if r := v.dig(key); r.truthy() {
				return r
			}
		}
	case n.arr:
		for _, v := range n.list {
			if r := v.dig(key); r.truthy() {
				return r
			}
		}
	}
	return nil
}

// pyInt - int(v) из Python для числа, строки и bool; ok=false - int() бросил бы исключение.
func (n *node) pyInt() (int, bool) {
	if n.obj || n.arr {
		return 0, false
	}
	switch v := n.v.(type) {
	case json.Number:
		if i, err := strconv.Atoi(v.String()); err == nil {
			return i, true
		}
		f, err := v.Float64()
		if err != nil || math.IsInf(f, 0) || math.Abs(f) > 1<<53 {
			return 0, false
		}
		return int(f), true
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(v))
		return i, err == nil
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// statusPort - порт прокси из mtproxyl status --json: первый истинный из port, proxy_port,
// PROXY_PORT (поиск в глубину по порядку ключей).
func statusPort(out string) (int, bool) {
	dec := json.NewDecoder(bytes.NewReader([]byte(out)))
	dec.UseNumber()
	root, err := parseOrdered(dec)
	if err != nil {
		return 0, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return 0, false // после значения ещё что-то - не JSON
	}
	for _, key := range []string{"port", "proxy_port", "PROXY_PORT"} {
		if v := root.dig(key); v.truthy() {
			return v.pyInt()
		}
	}
	return 0, false
}
