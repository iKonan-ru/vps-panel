package selfupdate

import (
	"context"
	"testing"
)

// Второе обновление, закончившись, не уносит отмену первого.
func TestCancelSurvivesSecondUpdate(t *testing.T) {
	ctx1, c1 := context.WithCancel(context.Background())
	_, c2 := context.WithCancel(context.Background())
	u1 := track(c1)
	track(c2)()
	if !Cancel() || ctx1.Err() == nil {
		t.Fatal("первое обновление не отменилось")
	}
	u1()
	if Cancel() {
		t.Fatal("после завершения обновлений отменять нечего")
	}
}
