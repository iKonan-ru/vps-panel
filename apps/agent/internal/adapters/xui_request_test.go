package adapters

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestXuiRequestForm(t *testing.T) {
	var got struct{ ct, body, query, auth string }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.ct, got.body, got.query, got.auth = r.Header.Get("Content-Type"), string(b), r.URL.RawQuery, r.Header.Get("Authorization")
		if f, _ := url.ParseQuery(string(b)); f.Get("xraySetting") != `{"a":"b c&d"}` {
			t.Errorf("форма: %q", string(b))
		}
	}))
	defer srv.Close()
	req, err := newXuiRequest(context.Background(), srv.URL+"/panel/api/", XuiAPIRequest{
		Token: "tok", Method: "post", Path: "xray/update",
		Form:  map[string]string{"xraySetting": `{"a":"b c&d"}`},
		Query: map[string]string{"file": "geosite_RU.dat"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := http.DefaultClient.Do(req); err != nil {
		t.Fatal(err)
	}
	if got.ct != "application/x-www-form-urlencoded" || got.query != "file=geosite_RU.dat" || got.auth != "Bearer tok" {
		t.Errorf("запрос: %+v", got)
	}
}

func TestXuiRequestJSON(t *testing.T) {
	req, err := newXuiRequest(context.Background(), "http://127.0.0.1:1/panel/api/", XuiAPIRequest{
		Token: "tok", Method: "POST", Path: "/inbounds/add", Body: json.RawMessage(`{"x":1}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.String() != "http://127.0.0.1:1/panel/api/inbounds/add" || req.Header.Get("Content-Type") != "application/json" {
		t.Errorf("%s %s", req.URL, req.Header.Get("Content-Type"))
	}
}
