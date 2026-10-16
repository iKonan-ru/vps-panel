package services

import (
	"context"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// XuiDB - где 3x-ui хранит данные. По умолчанию sqlite /etc/x-ui/x-ui.db, но 3x-ui
// умеет PostgreSQL: XUI_DB_TYPE=postgres и XUI_DB_DSN=postgres://... в /etc/default/x-ui
// (файл читает и сама служба, и бинарник x-ui при вызове из консоли).
type XuiDB struct {
	Type string // sqlite | postgres
	DSN  string
	Path string // путь к sqlite, если Type == sqlite
}

const xuiDefaults = "/etc/default/x-ui"

// ReadXuiDBConfig разбирает /etc/default/x-ui. Возвращает sqlite, если файла нет или тип не postgres.
func ReadXuiDBConfig() XuiDB {
	out := XuiDB{Type: "sqlite"}
	raw, err := os.ReadFile(hostfs.Path(xuiDefaults))
	if err != nil {
		return out
	}
	env := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		env[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	if strings.EqualFold(env["XUI_DB_TYPE"], "postgres") && env["XUI_DB_DSN"] != "" {
		out.Type, out.DSN = "postgres", env["XUI_DB_DSN"]
	}
	return out
}

// Разделители для psql: значения (stream_settings - JSON с переводами строк) не должны ломать разбор.
const (
	pgFieldSep  = "\x1f"
	pgRecordSep = "\x1e"
)

// pgQuery выполняет запрос через psql и возвращает строки как срезы полей.
// DSN уходит через переменную окружения, а не аргумент - чтобы не светить пароль в ps.
func pgQuery(ctx context.Context, dsn, query string) ([][]string, error) {
	if !shell.Has("psql") {
		return nil, errPsqlMissing
	}
	env, err := PgEnv(dsn)
	if err != nil {
		return nil, err
	}
	res, err := shell.RunEnv(ctx, `psql -At -F "$(printf '\x1f')" -R "$(printf '\x1e')" -c "$XUI_QUERY"`,
		append(env, "XUI_QUERY="+query), 30*time.Second, nil)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, &pgError{msg: strings.TrimSpace(res.Stderr)}
	}
	var rows [][]string
	for _, rec := range strings.Split(res.Stdout, pgRecordSep) {
		if strings.TrimSpace(rec) == "" {
			continue
		}
		rows = append(rows, strings.Split(rec, pgFieldSep))
	}
	return rows, nil
}

// PgEnv переводит DSN postgres://user:pass@host:port/db?sslmode=... в переменные PG*,
// чтобы psql и pg_dump подключались без пароля в аргументах.
func PgEnv(dsn string) ([]string, error) {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return nil, &pgError{msg: "не разобрать XUI_DB_DSN"}
	}
	env := []string{"PGHOST=" + u.Hostname(), "PGDATABASE=" + strings.TrimPrefix(u.Path, "/")}
	if p := u.Port(); p != "" {
		env = append(env, "PGPORT="+p)
	}
	if u.User != nil {
		env = append(env, "PGUSER="+u.User.Username())
		if pw, ok := u.User.Password(); ok {
			env = append(env, "PGPASSWORD="+pw)
		}
	}
	if m := u.Query().Get("sslmode"); m != "" {
		env = append(env, "PGSSLMODE="+m)
	}
	return env, nil
}

type pgError struct{ msg string }

func (e *pgError) Error() string { return "psql: " + e.msg }

var errPsqlMissing = &pgError{msg: "psql не установлен, а 3X-UI хранит данные в PostgreSQL"}
