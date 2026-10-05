package services

import (
	"crypto/tls"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// panelURL строит ссылку на веб-панель по порту: пробует TLS на 127.0.0.1:port.
// Если порт отвечает по TLS - https, а хост берётся из сертификата (первое
// DNS-имя), чтобы ссылка совпадала с именем, на которое выпущен сертификат.
// Иначе - http и публичный IP.
func panelURL(publicIP string, port int, path string) string {
	host := publicIP
	scheme := "http"
	if name, ok := tlsProbe(port); ok {
		scheme = "https"
		if name != "" {
			host = name
		}
	}
	return fmt.Sprintf("%s://%s:%d%s", scheme, host, port, path)
}

// tlsProbe возвращает (DNS-имя из сертификата, отвечает ли порт по TLS).
func tlsProbe(port int) (string, bool) {
	d := net.Dialer{Timeout: 1500 * time.Millisecond}
	raw, err := d.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return "", false
	}
	defer raw.Close()
	_ = raw.SetDeadline(time.Now().Add(2 * time.Second))
	c := tls.Client(raw, &tls.Config{InsecureSkipVerify: true}) //nolint:gosec // только проверка наличия TLS
	if err := c.Handshake(); err != nil {
		return "", false
	}
	certs := c.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "", true
	}
	for _, n := range certs[0].DNSNames {
		// имя из сертификата берём только если оно похоже на публичный домен
		if n != "" && n[0] != '*' && strings.Contains(n, ".") && n != "localhost" && !strings.HasSuffix(n, ".local") {
			return n, true
		}
	}
	return "", true
}
