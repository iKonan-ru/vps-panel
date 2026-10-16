package inventory

import (
	"errors"
	"slices"
	"testing"
)

func TestUncheckedKinds(t *testing.T) {
	cases := []struct {
		name         string
		dockerFailed bool
		xuiErr       error
		xuiFound     bool
		want         []string
	}{
		{"всё прочиталось", false, nil, true, []string{}},
		{"3X-UI нет, docker ответил", false, nil, false, []string{}},
		{"база 3X-UI не прочиталась", false, errors.New("locked"), false, []string{"xui"}},
		{"docker не ответил, 3X-UI на хосте", true, nil, true, []string{"amnezia", "wg-easy"}},
		{"docker не ответил, 3X-UI не найдена", true, nil, false, []string{"xui", "amnezia", "wg-easy"}},
	}
	for _, c := range cases {
		if got := uncheckedKinds(c.dockerFailed, c.xuiErr, c.xuiFound); !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, ждали %v", c.name, got, c.want)
		}
	}
}
