// Package hostfs - пути к файлам сервера, которые читает агент. Root задают только тесты (стенд
// port-sync с подменённым корнем); на сервере он пустой и пути остаются как есть.
package hostfs

// Root - корень, к которому приставляются абсолютные пути.
var Root string

// Path - путь p (абсолютный) внутри Root.
func Path(p string) string { return Root + p }
