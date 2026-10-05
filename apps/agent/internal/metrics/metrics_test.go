package metrics

import (
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/net"
)

func TestExternalSkipsVirtual(t *testing.T) {
	rx, tx := external([]net.IOCountersStat{
		{Name: "eth0", BytesRecv: 100, BytesSent: 50},
		{Name: "lo", BytesRecv: 1000, BytesSent: 1000},
		{Name: "veth1a2b", BytesRecv: 70, BytesSent: 70},
		{Name: "wg0", BytesRecv: 30, BytesSent: 30},
		{Name: "ens3", BytesRecv: 1, BytesSent: 2},
	})
	if rx != 101 || tx != 52 {
		t.Fatalf("rx=%d tx=%d", rx, tx)
	}
}

// Счётчик уменьшился (пропал интерфейс): замер пропускается, а не переполняется.
func TestRatesCounterDrop(t *testing.T) {
	c := NewCollector()
	t0 := time.Unix(1000, 0)
	if _, _, ok := c.rates(1000, 1000, t0); ok {
		t.Fatal("первый замер без прошлого дал скорость")
	}
	rx, tx, ok := c.rates(2000, 1500, t0.Add(time.Second))
	if !ok || rx != 8000 || tx != 4000 {
		t.Fatalf("rx=%v tx=%v ok=%v", rx, tx, ok)
	}
	if rx, tx, ok := c.rates(500, 1600, t0.Add(2*time.Second)); ok || rx != 0 || tx != 0 {
		t.Fatalf("после падения счётчика: rx=%v tx=%v ok=%v", rx, tx, ok)
	}
}
