package audit

import (
	"strings"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

func TestDownFinding(t *testing.T) {
	text, fix, url := downFinding(proto.Service{Kind: "mtproxyl", Title: "MTProxyL"}, "порт прокси 443 никто не слушает")
	if text != "MTProxyL: прокси не работает - Telegram-прокси недоступен" || url != "tab:mtproxyl" {
		t.Fatalf("%q %q", text, url)
	}
	if !strings.HasPrefix(fix, "Порт прокси 443 никто не слушает. ") {
		t.Fatalf("причина - в fix с заглавной: %q", fix)
	}
	// текст не зависит от причины: иначе каждая смена состояния контейнера - новое уведомление
	a, _, _ := downFinding(proto.Service{Kind: "amnezia", Title: "Amnezia awg2"}, "контейнер amnezia-awg2: exited")
	b, _, _ := downFinding(proto.Service{Kind: "amnezia", Title: "Amnezia awg2"}, "контейнер amnezia-awg2: restarting")
	if a != b {
		t.Fatal("текст замечания меняется вместе с причиной")
	}
	for kind, want := range map[string]string{"xui": "tab:xui", "amnezia": "tab:docker", "wg-easy": "tab:docker", "wdtt": "tab:terminal", "wireguard": "tab:terminal", "openflux": "tab:terminal"} {
		if _, _, u := downFinding(proto.Service{Kind: kind, Title: kind}, ""); u != want {
			t.Errorf("%s: %s", kind, u)
		}
	}
}
