package transport

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
)

// Канал v2. Агент доверяет не домену, а ключу панели ed25519:
//
//  1. агент -> панель (текстом): {"type":"hello2","eph":X25519 агента};
//  2. панель -> агент (текстом): {"type":"server-hello","eph":X25519 панели,"key":ed25519 панели,
//     "sig":подпись стенограммы}; агент сверяет key с запомненным (agent.json) и подпись;
//  3. дальше всё - двоичными кадрами AES-256-GCM, ключи направлений - HKDF от общего секрета
//     X25519, nonce - номер сообщения. Посредник с чужим сертификатом на домен панели не
//     расшифрует и не подделает ни одного сообщения, даже пересылая их настоящей панели;
//  4. агент доказывает знание токена (HMAC от sha256 токена по стенограмме) - сам токен по
//     сети больше не ходит; панель в welcome доказывает то же самое в ответ.
const handshakeContext = "vps-panel agent channel v2"

// channel - зашифрованный канал после рукопожатия.
type channel struct {
	send, recv       cipher.AEAD
	sendSeq, recvSeq uint64
}

func newGCM(key []byte) (cipher.AEAD, error) {
	b, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}

// nonce - номер сообщения в направлении: повтор, пропуск или перестановка ломают расшифровку.
func nonce(seq uint64) []byte {
	n := make([]byte, 12)
	binary.BigEndian.PutUint64(n[4:], seq)
	return n
}

func (c *channel) seal(p []byte) []byte {
	out := c.send.Seal(nil, nonce(c.sendSeq), p, nil)
	c.sendSeq++
	return out
}

func (c *channel) open(b []byte) ([]byte, error) {
	p, err := c.recv.Open(nil, nonce(c.recvSeq), b, nil)
	if err != nil {
		return nil, errors.New("сообщение панели не расшифровалось")
	}
	c.recvSeq++
	return p, nil
}

// transcript - хеш рукопожатия: его подписывает панель, к нему привязаны доказательства токена.
func transcript(ephA, ephP, key []byte) []byte {
	h := sha256.New()
	h.Write([]byte(handshakeContext))
	h.Write([]byte{0})
	h.Write(ephA)
	h.Write(ephP)
	h.Write(key)
	return h.Sum(nil)
}

// deriveChannel - ключи направлений из общего секрета X25519 (агент -> панель, панель -> агент).
func deriveChannel(shared, ephA, ephP []byte) (*channel, error) {
	salt := append(append([]byte{}, ephA...), ephP...)
	k, err := hkdf.Key(sha256.New, shared, salt, handshakeContext, 64)
	if err != nil {
		return nil, err
	}
	send, err := newGCM(k[:32])
	if err != nil {
		return nil, err
	}
	recv, err := newGCM(k[32:])
	if err != nil {
		return nil, err
	}
	return &channel{send: send, recv: recv}, nil
}

// TokenHash - sha256 токена в hex: так токен хранит панель, этим же ключом считается proof.
func TokenHash(token string) string {
	s := sha256.Sum256([]byte(token))
	return hex.EncodeToString(s[:])
}

// proof - HMAC-SHA256(ключ - hex sha256 токена, метка || стенограмма) в base64.
func proof(tokenHash, label string, th []byte) string {
	m := hmac.New(sha256.New, []byte(tokenHash))
	m.Write([]byte(label))
	m.Write(th)
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

// verifyServerHello проверяет ответ панели и выводит канал. pinned - запомненный ключ панели
// (nil - первое подключение после обновления старого агента: ключ принимается и запоминается,
// но только после того, как панель докажет в welcome знание токена).
func verifyServerHello(priv *ecdh.PrivateKey, pinned ed25519.PublicKey, ephPb64, keyB64, sigB64 string) (*channel, []byte, ed25519.PublicKey, error) {
	ephP, err1 := base64.StdEncoding.DecodeString(ephPb64)
	key, err2 := base64.StdEncoding.DecodeString(keyB64)
	sig, err3 := base64.StdEncoding.DecodeString(sigB64)
	if err1 != nil || err2 != nil || err3 != nil || len(ephP) != 32 || len(key) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return nil, nil, nil, errors.New("панель ответила не по протоколу v2")
	}
	if pinned != nil && !hmac.Equal(pinned, key) {
		return nil, nil, nil, errors.New("ключ панели не совпал с запомненным - это не наша панель, соединение отклонено")
	}
	ephA := priv.PublicKey().Bytes()
	th := transcript(ephA, ephP, key)
	if !ed25519.Verify(key, th, sig) {
		return nil, nil, nil, errors.New("подпись панели не сошлась - соединение отклонено")
	}
	pub, err := ecdh.X25519().NewPublicKey(ephP)
	if err != nil {
		return nil, nil, nil, err
	}
	shared, err := priv.ECDH(pub)
	if err != nil {
		return nil, nil, nil, err
	}
	ch, err := deriveChannel(shared, ephA, ephP)
	if err != nil {
		return nil, nil, nil, err
	}
	return ch, th, ed25519.PublicKey(key), nil
}
