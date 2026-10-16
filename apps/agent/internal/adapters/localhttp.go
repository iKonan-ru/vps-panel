package adapters

import (
	"crypto/tls"
	"net/http"
	"time"
)

// localTLS - клиент к панелям сервисов на этом же сервере (3X-UI, admin API WDTT). Сертификат на IP
// или самоподписанный: проверять цепочку на localhost бессмысленно. Транспорт один на процесс,
// чтобы keep-alive соединения не копились.
var localTLS = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		MaxIdleConns:    4,
		IdleConnTimeout: 90 * time.Second,
	},
}
