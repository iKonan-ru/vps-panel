package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseSelfSigned(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "example.test"},
		DNSNames:     []string{"example.test", "www.example.test"},
		IPAddresses:  []net.IP{net.ParseIP("203.0.113.5")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(20 * 24 * time.Hour),
		Issuer:       pkix.Name{CommonName: "R11"},
	}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	dir := t.TempDir()
	path := filepath.Join(dir, "fullchain.pem")
	_ = os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
	c, ok := parse(path)
	if !ok {
		t.Fatal("parse failed")
	}
	if len(c.Subjects) != 3 || c.Subjects[2] != "203.0.113.5" {
		t.Fatalf("subjects: %v", c.Subjects)
	}
	if c.DaysLeft < 19 || c.DaysLeft > 20 {
		t.Fatalf("daysLeft: %d", c.DaysLeft)
	}
}
