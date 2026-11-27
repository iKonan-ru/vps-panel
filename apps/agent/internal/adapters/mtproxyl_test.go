package adapters

import (
	"reflect"
	"testing"
)

func TestMtEngineUpdateTag(t *testing.T) {
	build := mtOps["engine.update"].build
	for _, tag := range []string{"3.5.17", "v3.5.17", "main", "dev"} {
		args, err := build(map[string]string{"version": tag})
		if err != nil || !reflect.DeepEqual(args, []string{"engine", "update", tag}) {
			t.Fatalf("%s: %v %v", tag, args, err)
		}
	}
	for _, tag := range []string{"", "--all", "nightly", "main;rm", "dev main"} {
		if _, err := build(map[string]string{"version": tag}); err == nil {
			t.Fatalf("%q: ожидалась ошибка", tag)
		}
	}
}
