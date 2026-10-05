// Package config читает и хранит конфиг агента: адрес панели и токен.
package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
)

const DefaultPath = "/etc/vps-agent/agent.json"

// Config хранится в /etc/vps-agent/agent.json с правами 0600.
type Config struct {
	// PanelURL - базовый адрес панели, например https://panel.example.com.
	PanelURL string `json:"panelUrl"`
	// PanelKey - ключ панели ed25519 (base64): агент верит ему, а не домену.
	// Передаётся в команде установки; у старых агентов пуст - первый ключ запоминается сам.
	PanelKey string `json:"panelKey,omitempty"`
	// Token - постоянный токен агента (выдаётся при регистрации).
	Token string `json:"token,omitempty"`
	// RegistrationToken - одноразовый токен, используется только при первом подключении.
	RegistrationToken string `json:"registrationToken,omitempty"`
	// ServerID - id сервера в панели, приходит в welcome.
	ServerID string `json:"serverId,omitempty"`
}

func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	if c.PanelURL == "" {
		return nil, errors.New("config: panelUrl is empty")
	}
	if err := CheckPanelURL(c.PanelURL); err != nil {
		return nil, err
	}
	if _, err := c.Key(); err != nil {
		return nil, err
	}
	if c.Token == "" && c.RegistrationToken == "" {
		return nil, errors.New("config: neither token nor registrationToken set")
	}
	return &c, nil
}

// Save пишет конфиг атомарно с правами 0600.
func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// CheckPanelURL - адрес панели только https:// (http:// - лишь на этой же машине, для стенда).
func CheckPanelURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("config: неверный panelUrl %q", raw)
	}
	if u.Scheme == "https" {
		return nil
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); u.Scheme == "http" && (host == "localhost" || (ip != nil && ip.IsLoopback())) {
		return nil
	}
	return fmt.Errorf("config: panelUrl должен быть https:// (сейчас %q)", raw)
}

// Key - запомненный ключ панели; nil - ещё не запомнен.
func (c *Config) Key() (ed25519.PublicKey, error) {
	if c.PanelKey == "" {
		return nil, nil
	}
	b, err := base64.StdEncoding.DecodeString(c.PanelKey)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("config: неверный panelKey")
	}
	return ed25519.PublicKey(b), nil
}
