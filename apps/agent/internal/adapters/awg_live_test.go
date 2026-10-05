package adapters

import (
	"context"
	"os"
	"strings"
	"testing"
)

// Живой прогон операций против локального контейнера AWG (только при AWG_LIVE=1). Подготовка:
// docker run -d --privileged --name amnezia-awg2-59999 --entrypoint sh amneziavpn/amneziawg-go -c 'tail -f /dev/null',
// ключи и awg0.conf в /opt/amnezia/awg, интерфейс через amneziawg-go (модуль ядра хоста может
// быть старее 3.x), K1 и K2 - публичные ключи двух клиентов.
func TestAwgLive(t *testing.T) {
	if os.Getenv("AWG_LIVE") != "1" {
		t.Skip()
	}
	ctx := context.Background()
	c := "amnezia-awg2-59999"
	show := func(step string) AwgInstance {
		for _, i := range AwgStatusAll(ctx).Instances {
			if i.Container == c {
				t.Logf("%s: версия %s, реализация %s, клиентов %d", step, i.Version, i.Impl, len(i.Clients))
				for _, cl := range i.Clients {
					t.Logf("   %s %q ips=%s inConfig=%v disabled=%v", cl.PublicKey[:8], cl.Name, cl.AllowedIPs, cl.InConfig, cl.Disabled)
				}
				return i
			}
		}
		t.Fatal("контейнер не найден")
		return AwgInstance{}
	}
	must := func(op, key, name string) map[string]any {
		r, err := AwgExec(ctx, AwgRequest{Op: op, Container: c, Args: map[string]string{"publicKey": key, "name": name}})
		if err != nil {
			t.Fatalf("%s: %v", op, err)
		}
		return r
	}
	k1, k2 := os.Getenv("K1"), os.Getenv("K2")
	show("старт")
	t.Log("add1", must("client.add", k1, "Иван телефон"))
	t.Log("add2", must("client.add", k2, "masha"))
	if _, err := AwgExec(ctx, AwgRequest{Op: "client.add", Container: c, Args: map[string]string{"publicKey": k1, "name": "dup"}}); err == nil {
		t.Fatal("дубликат ключа принят")
	}
	i := show("после добавления")
	if len(i.Clients) != 2 || i.Clients[0].AllowedIPs != "10.8.1.2/32" || i.Clients[1].AllowedIPs != "10.8.1.3/32" {
		t.Fatal("ждали двух клиентов .2 и .3")
	}
	must("client.disable", k1, "")
	i = show("после выключения")
	if i.Clients[0].InConfig || !i.Clients[0].Disabled {
		t.Fatal("клиент не выключился")
	}
	live, _ := dexec(ctx, c, "awg", "show", "awg0", "peers")
	if strings.Contains(live, k1) {
		t.Fatal("выключенный пир остался на живом интерфейсе")
	}
	must("client.enable", k1, "")
	must("client.rename", k2, "Маша ноутбук")
	i = show("после включения и переименования")
	if !i.Clients[0].InConfig || i.Clients[0].AllowedIPs != "10.8.1.2/32" || i.Clients[1].Name != "Маша ноутбук" {
		t.Fatal("включение/переименование")
	}
	must("client.remove", k1, "")
	i = show("после удаления")
	live, _ = dexec(ctx, c, "awg", "show", "awg0", "peers")
	if len(i.Clients) != 1 || strings.Contains(live, k1) || !strings.Contains(live, k2) {
		t.Fatal("удаление")
	}
	conf, _ := dexec(ctx, c, "cat", "/opt/amnezia/awg/awg0.conf")
	table, _ := dexec(ctx, c, "cat", "/opt/amnezia/awg/clientsTable")
	ls, _ := dexec(ctx, c, "ls", "-la", "/opt/amnezia/awg")
	t.Logf("awg0.conf:\n%s\nclientsTable:\n%s\n%s", conf, table, ls)
}
