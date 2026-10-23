// mcp-bridge: lets the platform host an MCP server that speaks stdio (P12). It runs inside the hosted
// server's own container, in front of the server's command:
//
//	/bridge/mcp-bridge -- <command> [args...]
//
// It serves MCP over HTTP (POST /mcp, JSON responses) with the bearer token in MCP_BEARER_TOKEN, and
// relays JSON-RPC to the child over its stdin and stdout, one message per line.
//
//   - Ids are remapped, so requests from different callers never collide in the single child session.
//   - The child is initialised once: later "initialize" requests get the first answer, with their own
//     id, and "notifications/initialized" is forwarded once.
//   - Each request waits at most REQUEST_TIMEOUT_SECONDS (30); lines over 1 MiB are refused.
//   - If the child exits it is restarted with a growing delay; /healthz fails while it is down.
//
// Static binary (no libc), so it runs in any image; the image only has to contain the command.
package main

import (
	"bufio"
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxLine = 1 << 20

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type bridge struct {
	mu          sync.Mutex
	stdin       io.WriteCloser
	alive       bool
	next        int64
	waiting     map[int64]chan message
	initResult  json.RawMessage // the child's answer to the first initialize
	initSent    bool
	initialized bool
	timeout     time.Duration
}

func (b *bridge) run(argv []string) {
	delay := time.Second
	for {
		started := time.Now()
		if err := b.once(argv); err != nil {
			log.Printf("child: %v", err)
		}
		b.mu.Lock()
		b.alive, b.initResult, b.initSent, b.initialized = false, nil, false, false
		for id, ch := range b.waiting {
			close(ch)
			delete(b.waiting, id)
		}
		b.mu.Unlock()
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		log.Printf("child stopped; restarting in %s", delay)
		time.Sleep(delay)
		if delay < 30*time.Second {
			delay *= 2
		}
	}
}

func (b *bridge) once(argv []string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	b.mu.Lock()
	b.stdin, b.alive = stdin, true
	b.mu.Unlock()
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), maxLine)
	for sc.Scan() {
		var m message
		if json.Unmarshal(sc.Bytes(), &m) != nil || len(m.ID) == 0 || m.Method != "" {
			continue // notifications and requests from the child are not relayed (no session to send them to)
		}
		id, err := strconv.ParseInt(string(m.ID), 10, 64)
		if err != nil {
			continue
		}
		b.mu.Lock()
		ch := b.waiting[id]
		delete(b.waiting, id)
		b.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
	return cmd.Wait()
}

// send writes one message to the child; for a request, it waits for the answer.
func (b *bridge) send(m message) (message, error) {
	b.mu.Lock()
	if !b.alive {
		b.mu.Unlock()
		return message{}, errors.New("the server is not running")
	}
	var ch chan message
	var id int64
	if len(m.ID) > 0 {
		b.next++
		id = b.next
		ch = make(chan message, 1)
		b.waiting[id] = ch
		m.ID = json.RawMessage(strconv.FormatInt(id, 10))
	}
	line, _ := json.Marshal(m)
	_, err := b.stdin.Write(append(line, '\n'))
	b.mu.Unlock()
	if err != nil || ch == nil {
		return message{}, err
	}
	select {
	case r, ok := <-ch:
		if !ok {
			return message{}, errors.New("the server stopped")
		}
		return r, nil
	case <-time.After(b.timeout):
		b.mu.Lock()
		delete(b.waiting, id)
		b.mu.Unlock()
		return message{}, fmt.Errorf("no answer within %s", b.timeout)
	}
}

func rpcError(id json.RawMessage, code int, text string) message {
	e, _ := json.Marshal(map[string]any{"code": code, "message": text})
	return message{JSONRPC: "2.0", ID: id, Error: e}
}

func (b *bridge) handle(w http.ResponseWriter, r *http.Request, token []byte) {
	got := []byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if len(token) == 0 || subtle.ConstantTimeCompare(got, token) != 1 {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "only POST", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxLine+1))
	if err != nil || len(body) > maxLine {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	var m message
	if json.Unmarshal(bytes.TrimSpace(body), &m) != nil || m.Method == "" {
		http.Error(w, "one JSON-RPC message per request", http.StatusBadRequest)
		return
	}
	callerID := m.ID
	// Notifications: forward (initialized only once) and acknowledge.
	if len(callerID) == 0 {
		b.mu.Lock()
		skip := m.Method == "notifications/initialized" && b.initialized
		if m.Method == "notifications/initialized" {
			b.initialized = true
		}
		b.mu.Unlock()
		if !skip {
			b.send(m)
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var out message
	b.mu.Lock()
	cached := m.Method == "initialize" && b.initResult != nil
	res := b.initResult
	b.mu.Unlock()
	if cached {
		out = message{JSONRPC: "2.0", Result: res}
	} else {
		out, err = b.send(m)
		if err != nil {
			out = rpcError(callerID, -32603, err.Error())
		} else if m.Method == "initialize" && out.Error == nil {
			b.mu.Lock()
			b.initResult = out.Result
			b.mu.Unlock()
		}
	}
	out.JSONRPC, out.ID = "2.0", callerID
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		log.Fatal("usage: mcp-bridge -- <command> [args...]")
	}
	port, path := os.Getenv("PORT"), os.Getenv("MCP_PATH")
	if port == "" {
		port = "8080"
	}
	if path == "" {
		path = "/mcp"
	}
	timeout := 30 * time.Second
	if s, err := strconv.Atoi(os.Getenv("REQUEST_TIMEOUT_SECONDS")); err == nil && s > 0 {
		timeout = time.Duration(s) * time.Second
	}
	token := []byte(os.Getenv("MCP_BEARER_TOKEN"))
	if len(token) == 0 {
		log.Fatal("missing MCP_BEARER_TOKEN")
	}
	b := &bridge{waiting: map[int64]chan message{}, timeout: timeout}
	go b.run(args)
	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) { b.handle(w, r, token) })
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		alive := b.alive
		b.mu.Unlock()
		if !alive {
			http.Error(w, "child not running", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	log.Printf("mcp-bridge on :%s%s -> %s", port, path, strings.Join(args, " "))
	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
