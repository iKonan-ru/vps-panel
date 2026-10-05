// Package proto - Go-зеркало схем из packages/protocol. Держать в синхроне вручную.
package proto

import "github.com/iKonan-ru/vps-panel/apps/agent/internal/metrics"

type Service struct {
	Kind     string         `json:"kind"`
	Title    string         `json:"title"`
	Version  string         `json:"version,omitempty"`
	Ports    []string       `json:"ports"`
	PanelURL string         `json:"panelUrl,omitempty"`
	Details  map[string]any `json:"details,omitempty"`
}

type Container struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Image          string   `json:"image"`
	State          string   `json:"state"`
	Status         string   `json:"status"`
	NetworkMode    string   `json:"networkMode"`
	Published      []string `json:"published"`
	ComposeProject string   `json:"composeProject,omitempty"`
	CPUPercent     *float64 `json:"cpuPercent,omitempty"`
	MemMb          *float64 `json:"memMb,omitempty"`
}

type FirewallRule struct {
	Port     string `json:"port"`
	Proto    string `json:"proto"`
	Source   string `json:"source"`
	Action   string `json:"action"`
	Origin   string `json:"origin"`
	Comment  string `json:"comment"`
	ManualID string `json:"manualId,omitempty"`
}

type Listener struct {
	Proto   string `json:"proto"`
	Port    int    `json:"port"`
	Process string `json:"process"`
	Open    bool   `json:"open"`
}

type FirewallState struct {
	UfwActive         bool           `json:"ufwActive"`
	DefaultIncoming   string         `json:"defaultIncoming"`
	PortsyncInstalled bool           `json:"portsyncInstalled"`
	PortsyncActive    bool           `json:"portsyncActive"`
	PortsyncLastRun   string         `json:"portsyncLastRun,omitempty"`
	DockerFiltered    bool           `json:"dockerFiltered"`
	Rules             []FirewallRule `json:"rules"`
	Listeners         []Listener     `json:"listeners"`
}

type Finding struct {
	Severity string `json:"severity"`
	Text     string `json:"text"`
	Fix      string `json:"fix"`
	URL      string `json:"url,omitempty"` // куда перейти, чтобы исправить
}

// Jail - статистика одного jail fail2ban.
type Jail struct {
	Name        string `json:"name"`
	Banned      int    `json:"banned"`      // забанено сейчас
	TotalBanned int    `json:"totalBanned"` // всего с запуска fail2ban
	Failed      int    `json:"failed"`      // неудачных попыток в окне findtime
	// BannedIPs - кто в бане сейчас (первые 100), чтобы видеть, откуда ломятся
	BannedIPs []string `json:"bannedIps"`
}

type Audit struct {
	SSHPort            int       `json:"sshPort"`
	SSHPasswordAuth    bool      `json:"sshPasswordAuth"`
	SSHPermitRootLogin string    `json:"sshPermitRootLogin"`
	Fail2banRunning    bool      `json:"fail2banRunning"`
	Fail2banJails      []string  `json:"fail2banJails"`
	Jails              []Jail    `json:"jails"`
	UnattendedUpgrades bool      `json:"unattendedUpgrades"`
	PendingUpdates     int       `json:"pendingUpdates"`
	RebootRequired     bool      `json:"rebootRequired"`
	Findings           []Finding `json:"findings"`
}

type Inventory struct {
	Host        metrics.HostInfo `json:"host"`
	Services    []Service        `json:"services"`
	Containers  []Container      `json:"containers"`
	Firewall    FirewallState    `json:"firewall"`
	Audit       Audit            `json:"audit"`
	Certs       []Cert           `json:"certs"`
	CollectedAt string           `json:"collectedAt"`
}

// Cert - TLS-сертификат на сервере: от acme.sh, certbot или указанный в x-ui.
type Cert struct {
	Name      string   `json:"name"`
	Source    string   `json:"source"` // acme.sh | certbot | xui | mtproxyl | caddy | naive | other
	Path      string   `json:"path"`   // fullchain
	KeyPath   string   `json:"keyPath"`
	Subjects  []string `json:"subjects"` // домены и IP из SAN
	Issuer    string   `json:"issuer"`
	NotBefore string   `json:"notBefore"`
	NotAfter  string   `json:"notAfter"`
	DaysLeft  int      `json:"daysLeft"`
	AutoRenew bool     `json:"autoRenew"` // есть cron/таймер продления (acme.sh или certbot)
	UsedBy    []string `json:"usedBy"`    // xui, systemd:<unit>, docker:<name>
}
