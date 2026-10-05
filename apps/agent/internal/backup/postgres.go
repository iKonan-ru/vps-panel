package backup

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

const xuiPgDump = "x-ui-postgres.sql"

// pgDump сохраняет базу 3x-ui в файл (pg_dump --clean --if-exists, без владельцев и прав).
func pgDump(ctx context.Context, dsn, dst string) (int64, error) {
	if !shell.Has("pg_dump") {
		return 0, errors.New("pg_dump не установлен (пакет postgresql-client)")
	}
	env, err := services.PgEnv(dsn)
	if err != nil {
		return 0, err
	}
	res, err := shell.RunEnv(ctx, "pg_dump --clean --if-exists --no-owner --no-privileges -f "+shell.Quote(dst), env, 5*time.Minute, nil)
	if err != nil {
		return 0, err
	}
	if res.ExitCode != 0 {
		return 0, errors.New(strings.TrimSpace(res.Stderr))
	}
	st, err := os.Stat(dst)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// pgRestore заливает дамп в базу 3x-ui: дамп с --clean сам удаляет и создаёт таблицы.
func pgRestore(ctx context.Context, dsn, dump string, stream func(channel, chunk string)) error {
	if !shell.Has("psql") {
		return errors.New("psql не установлен (пакет postgresql-client)")
	}
	env, err := services.PgEnv(dsn)
	if err != nil {
		return err
	}
	res, err := shell.RunEnv(ctx, "psql -v ON_ERROR_STOP=1 -q -f "+shell.Quote(dump), env, 10*time.Minute, stream)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return errors.New("psql завершился с кодом " + strconv.Itoa(res.ExitCode))
	}
	return nil
}
