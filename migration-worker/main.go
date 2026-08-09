package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	workerVersion = "migration-worker-v1"
	jobVersion    = 1
	stateVersion  = 1
)

const productionSigningPublicKeyPath = "/var/lib/alphanine/migration-worker/suite-job-signing.pub"

type FileIdentity struct {
	Path   string `json:"path"`
	Size   string `json:"size"`
	SHA256 string `json:"sha256"`
}

type Command struct {
	Purpose                  string             `json:"purpose"`
	Executable               string             `json:"executable"`
	Arguments                []string           `json:"arguments"`
	Environment              map[string]string  `json:"environment,omitempty"`
	StdinFile                string             `json:"stdinFile,omitempty"`
	StdoutFile               string             `json:"stdoutFile,omitempty"`
	ExpectedExit             int                `json:"expectedExit"`
	TimeoutSeconds           int                `json:"timeoutSeconds"`
	AssertFiles              []FileIdentity     `json:"assertFiles,omitempty"`
	AssertStdoutSHA256       string             `json:"assertStdoutSha256,omitempty"`
	AssertEvidenceKind       string             `json:"assertEvidenceKind,omitempty"`
	ExpectedEvidence         json.RawMessage    `json:"expectedEvidence,omitempty"`
	RecordFileIdentity       string             `json:"recordFileIdentity,omitempty"`
	RecordAs                 string             `json:"recordAs,omitempty"`
	AssertStdoutArtifactHash string             `json:"assertStdoutArtifactHash,omitempty"`
	AssertStdoutArtifactSize string             `json:"assertStdoutArtifactSize,omitempty"`
	ExpectedStdoutFirstField string             `json:"expectedStdoutFirstField,omitempty"`
	ValidateTocProfile       string             `json:"validateTocProfile,omitempty"`
	ValidateRestoreSQL       string             `json:"validateRestoreSql,omitempty"`
	ValidateOffline          *OfflineValidation `json:"validateOffline,omitempty"`
	RemoveFiles              []string           `json:"removeFiles,omitempty"`
}

type OfflineValidation struct {
	BattlegroupFiles []string `json:"battlegroupFiles"`
	WorkloadFiles    []string `json:"workloadFiles"`
	Namespace        string   `json:"namespace"`
	Name             string   `json:"name"`
}

type Stage struct {
	Name               string    `json:"name"`
	Detail             string    `json:"detail"`
	ModificationBegins bool      `json:"modificationBegins,omitempty"`
	MinimumDurationMS  int       `json:"minimumDurationMs,omitempty"`
	Commands           []Command `json:"commands"`
}

type Job struct {
	Version               int            `json:"version"`
	JobID                 string         `json:"jobId"`
	CreatedAt             string         `json:"createdAt"`
	Package               FileIdentity   `json:"package"`
	Worker                FileIdentity   `json:"worker"`
	Inputs                []FileIdentity `json:"inputs"`
	DestinationCheckpoint string         `json:"destinationCheckpoint"`
	RollbackCheckpoint    string         `json:"rollbackCheckpoint"`
	Stages                []Stage        `json:"stages"`
	RollbackStages        []Stage        `json:"rollbackStages"`
	Cleanup               []Command      `json:"cleanup"`
}

type Attempt struct {
	Purpose      string `json:"purpose"`
	StartedAt    string `json:"startedAt"`
	FinishedAt   string `json:"finishedAt"`
	ExitCode     int    `json:"exitCode"`
	Signal       string `json:"signal,omitempty"`
	TimedOut     bool   `json:"timedOut"`
	StdoutTail   string `json:"stdoutTail,omitempty"`
	StderrTail   string `json:"stderrTail,omitempty"`
	StdoutSHA256 string `json:"stdoutSha256,omitempty"`
}

type State struct {
	Version             int                     `json:"version"`
	WorkerVersion       string                  `json:"workerVersion"`
	JobID               string                  `json:"jobId"`
	Status              string                  `json:"status"`
	Stage               string                  `json:"stage"`
	Detail              string                  `json:"detail"`
	StartedAt           string                  `json:"startedAt"`
	UpdatedAt           string                  `json:"updatedAt"`
	FinishedAt          string                  `json:"finishedAt,omitempty"`
	Heartbeat           string                  `json:"heartbeat"`
	PID                 string                  `json:"pid"`
	ModificationStarted bool                    `json:"modificationStarted"`
	RollbackAttempted   bool                    `json:"rollbackAttempted"`
	RollbackVerified    bool                    `json:"rollbackVerified"`
	ErrorCode           string                  `json:"errorCode,omitempty"`
	Error               string                  `json:"error,omitempty"`
	FailureStage        string                  `json:"failureStage,omitempty"`
	FailureCause        string                  `json:"failureCause,omitempty"`
	Attempts            []Attempt               `json:"attempts"`
	Artifacts           map[string]FileIdentity `json:"artifacts,omitempty"`
}

type workerError struct{ code, message string }

func (e *workerError) Error() string { return e.message }

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func main() {
	if len(os.Args) < 2 {
		fatal("usage", "usage: alphanine-migration-worker <install|launch|run|status> ...")
	}
	if os.Args[1] == "install" {
		if len(os.Args) != 4 {
			fatal("usage", "install requires bundle and job directory")
		}
		if err := installJobBundle(os.Args[2], os.Args[3]); err != nil {
			fatal("job_install", err.Error())
		}
		fmt.Println("A9_MIGRATION_JOB_INSTALLED")
		return
	}
	if len(os.Args) != 3 {
		fatal("usage", "launch, run, and status require a job directory")
	}
	dir, err := filepath.Abs(os.Args[2])
	if err != nil {
		fatal("job_path", "job directory is invalid")
	}
	switch os.Args[1] {
	case "launch":
		job, _ := loadVerifiedJob(dir)
		statePath := filepath.Join(dir, "state.json")
		if state, err := readState(statePath); err == nil && (state.Status == "working" || state.Status == "rollback") {
			fatal("job_active", "migration job is already active")
		}
		cmd := exec.Command(os.Args[0], "run", dir)
		cmd.Dir = dir
		logFile, err := os.OpenFile(filepath.Join(dir, "worker.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			fatal("worker_log", "worker log could not be opened")
		}
		defer logFile.Close()
		cmd.Stdout, cmd.Stderr = logFile, logFile
		cmd.SysProcAttr = detachedProcessAttributes()
		if err := cmd.Start(); err != nil {
			fatal("worker_start", "worker could not be started")
		}
		fmt.Printf("A9_MIGRATION_WORKER_STARTED %s %d\n", job.JobID, cmd.Process.Pid)
	case "run":
		if err := run(dir); err != nil {
			os.Exit(1)
		}
	case "status":
		state, err := readState(filepath.Join(dir, "state.json"))
		if err != nil {
			fatal("state_unavailable", "migration worker state is unavailable")
		}
		if heartbeat, readErr := os.ReadFile(filepath.Join(dir, "heartbeat")); readErr == nil && strings.TrimSpace(string(heartbeat)) != "" {
			state.Heartbeat = strings.TrimSpace(string(heartbeat))
		}
		encoded, _ := json.Marshal(state)
		fmt.Println(string(encoded))
	default:
		fatal("usage", "unsupported migration worker action")
	}
}

var bundleLeafPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

func installJobBundle(bundlePath, jobDir string) error {
	bundleAbs, err := filepath.Abs(bundlePath)
	if err != nil {
		return errors.New("job bundle path is invalid")
	}
	jobAbs, err := filepath.Abs(jobDir)
	if err != nil {
		return errors.New("job directory is invalid")
	}
	root := "/var/lib/alphanine/migration-worker/jobs/"
	if !strings.HasPrefix(jobAbs, root) || strings.Contains(filepath.Base(jobAbs), "..") {
		return errors.New("job installation target is unsafe")
	}
	next := jobAbs + ".next"
	_ = os.RemoveAll(next)
	if err := os.MkdirAll(next, 0700); err != nil {
		return errors.New("job staging directory could not be created")
	}
	installed := false
	defer func() {
		if !installed {
			_ = os.RemoveAll(next)
		}
	}()
	f, err := os.Open(bundleAbs)
	if err != nil {
		return errors.New("job bundle could not be opened")
	}
	defer f.Close()
	seen := map[string]bool{}
	for {
		header := make([]byte, 512)
		_, readErr := io.ReadFull(f, header)
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return errors.New("job bundle is truncated or malformed")
		}
		allZero := true
		for _, b := range header {
			if b != 0 {
				allZero = false
				break
			}
		}
		if allZero {
			break
		}
		storedChecksum, parseErr := parseTarOctal(header[148:156])
		if parseErr != nil {
			return errors.New("job bundle checksum is malformed")
		}
		checksumHeader := append([]byte(nil), header...)
		for i := 148; i < 156; i++ {
			checksumHeader[i] = 0x20
		}
		var actualChecksum int64
		for _, b := range checksumHeader {
			actualChecksum += int64(b)
		}
		if storedChecksum != actualChecksum {
			return errors.New("job bundle checksum differs")
		}
		name := strings.TrimRight(string(header[:100]), "\x00")
		size, parseErr := parseTarOctal(header[124:136])
		if parseErr != nil {
			return errors.New("job bundle entry size is malformed")
		}
		if header[156] != '0' && header[156] != 0 {
			return errors.New("job bundle contains a non-regular entry")
		}
		if !bundleLeafPattern.MatchString(name) || seen[name] {
			return errors.New("job bundle contains an unsafe or duplicate entry")
		}
		if size < 0 || size > 1<<34 {
			return errors.New("job bundle entry size is invalid")
		}
		seen[name] = true
		out, createErr := os.OpenFile(filepath.Join(next, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if createErr != nil {
			return errors.New("job bundle entry could not be created")
		}
		_, copyErr := io.CopyN(out, f, size)
		syncErr := out.Sync()
		closeErr := out.Close()
		if copyErr != nil || syncErr != nil || closeErr != nil {
			return errors.New("job bundle entry could not be durably written")
		}
		padding := (512 - (size % 512)) % 512
		if padding > 0 {
			if _, err := io.CopyN(io.Discard, f, padding); err != nil {
				return errors.New("job bundle padding is truncated")
			}
		}
	}
	job, _ := loadVerifiedJob(next)
	if job.JobID != filepath.Base(jobAbs) {
		return errors.New("signed job identity differs from its installation target")
	}
	if err := os.RemoveAll(jobAbs); err != nil {
		return errors.New("prior terminal job directory could not be replaced")
	}
	if err := os.Rename(next, jobAbs); err != nil {
		return errors.New("verified job could not be published atomically")
	}
	installed = true
	return nil
}

func parseTarOctal(value []byte) (int64, error) {
	text := strings.Trim(string(value), " \x00")
	if text == "" {
		return 0, nil
	}
	for _, r := range text {
		if r < '0' || r > '7' {
			return 0, errors.New("invalid tar octal")
		}
	}
	parsed, err := strconv.ParseInt(text, 8, 64)
	if err != nil {
		return 0, err
	}
	return parsed, nil
}

func fatal(code, message string) {
	b, _ := json.Marshal(map[string]string{"ok": "false", "code": code, "error": message})
	fmt.Fprintln(os.Stderr, string(b))
	os.Exit(2)
}

func run(dir string) error {
	job, jobDigest := loadVerifiedJob(dir)
	state := &State{Version: stateVersion, WorkerVersion: workerVersion, JobID: job.JobID, Status: "working", Stage: "starting", Detail: "Validating durable migration job", StartedAt: now(), UpdatedAt: now(), Heartbeat: now(), PID: strconv.Itoa(os.Getpid()), Attempts: []Attempt{}, Artifacts: map[string]FileIdentity{}}
	statePath := filepath.Join(dir, "state.json")
	if err := writeState(statePath, state); err != nil {
		return err
	}
	lockPath := filepath.Join(filepath.Dir(filepath.Dir(dir)), "active.lock")
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return finishFailure(statePath, state, "worker_lock", "another worker owns this job")
	}
	fmt.Fprintf(lock, "%d\n%s\n", os.Getpid(), jobDigest)
	lock.Sync()
	lock.Close()
	defer os.Remove(lockPath)

	stopHeartbeat := make(chan struct{})
	go heartbeatLoop(filepath.Join(dir, "heartbeat"), stopHeartbeat)
	defer close(stopHeartbeat)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		state.ErrorCode = "worker_interrupted"
		state.Error = "Migration worker was interrupted."
		writeState(statePath, state)
	}()

	if err := verifyAllInputs(dir, job); err != nil {
		return finishFailure(statePath, state, "job_input_invalid", err.Error())
	}
	for _, stage := range job.Stages {
		state.Stage, state.Detail = stage.Name, stage.Detail
		if stage.ModificationBegins {
			state.ModificationStarted = true
		}
		writeState(statePath, state)
		if stage.MinimumDurationMS > 0 {
			if stage.MinimumDurationMS > 10000 {
				return finishFailure(statePath, state, "job_stage_hold_invalid", "Signed test stage hold exceeds its safety bound.")
			}
			time.Sleep(time.Duration(stage.MinimumDurationMS) * time.Millisecond)
		}
		if err := runStage(dir, stage, statePath, state); err != nil {
			state.FailureStage, state.FailureCause = stage.Name, err.Error()
			if state.ModificationStarted {
				state.Status, state.Stage, state.Detail, state.RollbackAttempted = "rollback", "automatic-rollback", "Restoring and verifying the exact destination checkpoint", true
				writeState(statePath, state)
				rollbackErr := runStages(dir, job.RollbackStages, statePath, state)
				if rollbackErr == nil {
					state.RollbackVerified = true
					runCleanup(dir, job.Cleanup, statePath, state)
					return finishFailure(statePath, state, "import_failed_rolled_back", "Import failed; the verified rollback checkpoint was restored.")
				}
				runCleanup(dir, job.Cleanup, statePath, state)
				return finishFailure(statePath, state, "rollback_failed", "Import failed and automatic rollback could not be verified: "+rollbackErr.Error())
			}
			runCleanup(dir, job.Cleanup, statePath, state)
			return finishFailure(statePath, state, "import_failed_before_modification", err.Error())
		}
	}
	if err := runCleanup(dir, job.Cleanup, statePath, state); err != nil {
		state.FailureStage, state.FailureCause = "cleanup", err.Error()
		if state.ModificationStarted {
			state.Status, state.Stage, state.Detail, state.RollbackAttempted = "rollback", "automatic-rollback", "Final cleanup failed; restoring the exact destination checkpoint", true
			_ = writeState(statePath, state)
			if rollbackErr := runStages(dir, job.RollbackStages, statePath, state); rollbackErr == nil {
				state.RollbackVerified = true
				_ = runCleanup(dir, job.Cleanup, statePath, state)
				return finishFailure(statePath, state, "cleanup_failed_rolled_back", "Final cleanup failed; the verified rollback checkpoint was restored.")
			}
			return finishFailure(statePath, state, "cleanup_failed_rollback_failed", "Final cleanup failed and automatic rollback could not be verified.")
		}
		return finishFailure(statePath, state, "cleanup_failed", err.Error())
	}
	state.Status, state.Stage, state.Detail = "verified", "complete", "Migration import and all verification completed"
	state.FinishedAt, state.UpdatedAt, state.Heartbeat = now(), now(), now()
	return writeState(statePath, state)
}

func runStages(dir string, stages []Stage, statePath string, state *State) error {
	for _, stage := range stages {
		state.Stage, state.Detail = stage.Name, stage.Detail
		writeState(statePath, state)
		if err := runStage(dir, stage, statePath, state); err != nil {
			return err
		}
	}
	return nil
}

func runStage(dir string, stage Stage, statePath string, state *State) error {
	for _, command := range stage.Commands {
		if err := runCommand(dir, command, statePath, state); err != nil {
			return err
		}
	}
	return nil
}

func runCleanup(dir string, commands []Command, statePath string, state *State) error {
	var errs []string
	for _, command := range commands {
		if err := runCommand(dir, command, statePath, state); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

var executableAllowlist = map[string]bool{
	"/usr/bin/sudo": true, "/usr/bin/kubectl": true, "/bin/mkdir": true, "/bin/rm": true,
	"/bin/cp": true, "/bin/mv": true, "/bin/chmod": true, "/usr/bin/sha256sum": true,
	"/usr/bin/stat": true, "/usr/bin/test": true, "/usr/bin/sync": true,
}

func runCommand(dir string, spec Command, statePath string, state *State) error {
	if !executableAllowlist[spec.Executable] {
		return fmt.Errorf("command %s uses an unapproved executable", spec.Purpose)
	}
	if spec.Purpose == "" || spec.TimeoutSeconds < 1 || spec.TimeoutSeconds > 86400 {
		return errors.New("command contract is invalid")
	}
	for _, arg := range spec.Arguments {
		if strings.ContainsRune(arg, 0) {
			return errors.New("command argument contains NUL")
		}
	}
	started := now()
	attempt := Attempt{Purpose: spec.Purpose, StartedAt: started, ExitCode: -1}
	state.Detail = spec.Purpose
	writeState(statePath, state)
	cmd := exec.Command(spec.Executable, spec.Arguments...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C"}
	for key, value := range spec.Environment {
		if !safeEnvName(key) {
			return errors.New("invalid environment name")
		}
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	var stdin *os.File
	if spec.StdinFile != "" {
		var err error
		stdin, err = os.Open(safeJobPath(dir, spec.StdinFile))
		if err != nil {
			return err
		}
		defer stdin.Close()
		cmd.Stdin = stdin
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	var stdoutFile *os.File
	if spec.StdoutFile != "" {
		var err error
		stdoutFile, err = os.OpenFile(safeJobPath(dir, spec.StdoutFile), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer stdoutFile.Close()
		cmd.Stdout = stdoutFile
	} else {
		cmd.Stdout = &stdout
	}
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		attempt.FinishedAt = now()
		attempt.StderrTail = tail(err.Error())
		state.Attempts = append(state.Attempts, attempt)
		writeState(statePath, state)
		return fmt.Errorf("%s failed to start", spec.Purpose)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(time.Duration(spec.TimeoutSeconds) * time.Second)
	var waitErr error
	select {
	case waitErr = <-done:
		timer.Stop()
	case <-timer.C:
		attempt.TimedOut = true
		cmd.Process.Kill()
		waitErr = <-done
	}
	attempt.FinishedAt = now()
	attempt.StdoutTail = tail(stdout.String())
	attempt.StderrTail = tail(stderr.String())
	if stdout.Len() > 0 {
		digest := sha256.Sum256([]byte(strings.TrimSpace(stdout.String())))
		attempt.StdoutSHA256 = hex.EncodeToString(digest[:])
	}
	if waitErr == nil {
		attempt.ExitCode = 0
	} else if exit, ok := waitErr.(*exec.ExitError); ok {
		attempt.ExitCode = exit.ExitCode()
		if exit.ProcessState.Sys() != nil {
			if ws, ok := exit.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				attempt.Signal = ws.Signal().String()
			}
		}
	}
	state.Attempts = append(state.Attempts, attempt)
	if len(state.Attempts) > 512 {
		state.Attempts = state.Attempts[len(state.Attempts)-512:]
	}
	writeState(statePath, state)
	if attempt.TimedOut || attempt.ExitCode != spec.ExpectedExit {
		return fmt.Errorf("%s failed (exit %d)", spec.Purpose, attempt.ExitCode)
	}
	stdoutText := strings.TrimSpace(stdout.String())
	if spec.AssertStdoutSHA256 != "" {
		digest := sha256.Sum256([]byte(stdoutText))
		if hex.EncodeToString(digest[:]) != strings.ToLower(spec.AssertStdoutSHA256) {
			diagnosticPath := filepath.Join(dir, "failure-evidence.txt")
			if writeErr := os.WriteFile(diagnosticPath, []byte(stdoutText+"\n"), 0600); writeErr == nil {
				if identity, identityErr := fileIdentity(dir, "failure-evidence.txt"); identityErr == nil {
					state.Artifacts["failureEvidence"] = identity
					_ = writeState(statePath, state)
				}
			}
			return fmt.Errorf("%s output checkpoint mismatch", spec.Purpose)
		}
	}
	if spec.AssertEvidenceKind != "" {
		if err := assertEvidence(stdoutText, spec.AssertEvidenceKind, spec.ExpectedEvidence); err != nil {
			return fmt.Errorf("%s: %w", spec.Purpose, err)
		}
	}
	for _, expected := range spec.AssertFiles {
		if err := verifyFile(dir, expected); err != nil {
			return fmt.Errorf("%s: %w", spec.Purpose, err)
		}
	}
	if spec.RecordFileIdentity != "" {
		if spec.RecordAs == "" {
			return errors.New("recorded artifact name is missing")
		}
		identity, err := fileIdentity(dir, spec.RecordFileIdentity)
		if err != nil {
			return err
		}
		state.Artifacts[spec.RecordAs] = identity
		_ = writeState(statePath, state)
	}
	if spec.AssertStdoutArtifactHash != "" {
		artifact, ok := state.Artifacts[spec.AssertStdoutArtifactHash]
		if !ok || firstField(stdoutText) != artifact.SHA256 {
			return fmt.Errorf("%s remote and durable hashes differ", spec.Purpose)
		}
	}
	if spec.AssertStdoutArtifactSize != "" {
		artifact, ok := state.Artifacts[spec.AssertStdoutArtifactSize]
		if !ok || firstField(stdoutText) != artifact.Size {
			return fmt.Errorf("%s remote and durable sizes differ", spec.Purpose)
		}
	}
	if spec.ExpectedStdoutFirstField != "" && firstField(stdoutText) != spec.ExpectedStdoutFirstField {
		return fmt.Errorf("%s output identity differs", spec.Purpose)
	}
	if spec.ValidateTocProfile != "" {
		if spec.StdoutFile == "" {
			return errors.New("TOC validation requires a durable output file")
		}
		if err := validateTocFile(safeJobPath(dir, spec.StdoutFile), spec.ValidateTocProfile); err != nil {
			return fmt.Errorf("%s: %w", spec.Purpose, err)
		}
	}
	if spec.ValidateRestoreSQL != "" {
		if err := validateRestoreSQLFile(safeJobPath(dir, spec.ValidateRestoreSQL)); err != nil {
			return fmt.Errorf("%s: %w", spec.Purpose, err)
		}
	}
	if spec.ValidateOffline != nil {
		if err := validateOfflineFiles(dir, *spec.ValidateOffline); err != nil {
			return fmt.Errorf("%s: %w", spec.Purpose, err)
		}
	}
	for _, name := range spec.RemoveFiles {
		if err := os.Remove(safeJobPath(dir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func safeEnvName(v string) bool {
	if v == "" {
		return false
	}
	for _, r := range v {
		if !(r == '_' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}
func tail(v string) string {
	v = strings.TrimSpace(v)
	if len(v) > 4096 {
		return v[len(v)-4096:]
	}
	return v
}

func firstField(v string) string {
	fields := strings.Fields(v)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

func assertEvidence(stdout, kind string, expected json.RawMessage) error {
	var actual map[string]any
	if err := json.Unmarshal([]byte(stdout), &actual); err != nil {
		return errors.New("evidence output is malformed JSON")
	}
	var normalized any = actual
	switch kind {
	case "exact-json":
	case "relationship":
		input, ok := actual["sha256Input"].(string)
		if !ok {
			return errors.New("relationship digest input is missing")
		}
		d := sha256.Sum256([]byte(input))
		normalized = map[string]any{"foreignKeyCount": actual["foreignKeyCount"], "invalidForeignKeys": actual["invalidForeignKeys"], "sha256": hex.EncodeToString(d[:])}
	case "sequence":
		input, ok := actual["sha256Input"].(string)
		if !ok {
			return errors.New("sequence digest input is missing")
		}
		d := sha256.Sum256([]byte(input))
		normalized = map[string]any{"sequenceCount": actual["sequenceCount"], "sha256": hex.EncodeToString(d[:])}
	case "cross-schema":
		input, ok := actual["sha256Input"].(string)
		if !ok {
			return errors.New("cross-schema digest input is missing")
		}
		d := sha256.Sum256([]byte(input))
		normalized = map[string]any{"count": actual["count"], "sha256": hex.EncodeToString(d[:])}
	default:
		return errors.New("unsupported evidence comparison")
	}
	actualBytes, err := json.Marshal(normalized)
	if err != nil {
		return err
	}
	var expectedValue any
	if len(expected) == 0 || json.Unmarshal(expected, &expectedValue) != nil {
		return errors.New("signed expected evidence is malformed")
	}
	expectedBytes, _ := json.Marshal(expectedValue)
	if !bytes.Equal(actualBytes, expectedBytes) {
		return errors.New("evidence differs from signed checkpoint")
	}
	return nil
}

var tocLine = regexp.MustCompile(`^\s*\d+;\s+\d+\s+\d+\s+(.+?)\s*$`)
var tocDescriptors = []string{"MATERIALIZED VIEW DATA", "SEQUENCE OWNED BY", "DATABASE PROPERTIES", "FK CONSTRAINT", "INDEX ATTACH", "TABLE ATTACH", "TABLE DATA", "SEQUENCE SET", "MATERIALIZED VIEW", "FOREIGN TABLE", "PROCEDURE", "AGGREGATE", "FUNCTION", "TRIGGER", "CONSTRAINT", "INDEX", "SEQUENCE", "VIEW", "TABLE", "TYPE", "DOMAIN", "SCHEMA", "EXTENSION", "COLLATION", "CONVERSION", "CAST", "DEFAULT", "POLICY", "COMMENT", "ACL", "ENCODING", "STDSTRINGS", "SEARCHPATH", "DATABASE"}

func validateTocFile(path, profile string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	classes := map[string]bool{}
	extensions := map[string]bool{}
	entries := 0
	for _, line := range strings.Split(string(b), "\n") {
		match := tocLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		body := match[1]
		if seen[body] {
			return errors.New("archive TOC contains a duplicate entry")
		}
		seen[body] = true
		entries++
		descriptor := ""
		for _, candidate := range tocDescriptors {
			if body == candidate || strings.HasPrefix(body, candidate+" ") {
				descriptor = candidate
				break
			}
		}
		if descriptor == "" {
			return errors.New("archive TOC contains an unsupported descriptor")
		}
		fields := tocFields(strings.TrimSpace(strings.TrimPrefix(body, descriptor)))
		if len(fields) == 0 {
			return errors.New("archive TOC entry is malformed")
		}
		schema := fields[0]
		if descriptor == "SCHEMA" && len(fields) > 1 {
			schema = fields[1]
		}
		classes[descriptor] = true
		if descriptor == "EXTENSION" && len(fields) > 1 {
			extensions[fields[1]] = true
		}
		if isSystemSchema(schema) {
			return errors.New("archive TOC contains a system-schema object")
		}
		if profile == "dune-only" && !sessionDescriptor(descriptor) && descriptor != "DATABASE" && schema != "dune" {
			return errors.New("migration archive contains an object outside dune")
		}
	}
	if entries == 0 || !classes["SCHEMA"] || !containsDuneSchema(string(b)) {
		return errors.New("archive TOC is empty or missing dune schema")
	}
	if profile == "dune-only" {
		for _, class := range []string{"TABLE", "TABLE DATA", "SEQUENCE", "SEQUENCE SET", "TYPE", "FUNCTION", "CONSTRAINT", "INDEX", "FK CONSTRAINT", "TABLE ATTACH"} {
			if !classes[class] {
				return fmt.Errorf("migration archive is missing required %s entries", class)
			}
		}
	} else if profile == "full-database" {
		if !extensions["pgcrypto"] || !extensions["pg_trgm"] {
			return errors.New("rollback archive is missing required extensions")
		}
	} else {
		return errors.New("unknown TOC validation profile")
	}
	return nil
}

func sessionDescriptor(v string) bool {
	return v == "ENCODING" || v == "STDSTRINGS" || v == "SEARCHPATH" || v == "COMMENT" || v == "ACL"
}
func isSystemSchema(v string) bool {
	v = strings.ToLower(v)
	return v == "pg_catalog" || v == "information_schema" || strings.HasPrefix(v, "pg_toast") || strings.HasPrefix(v, "pg_temp")
}
func containsDuneSchema(v string) bool {
	return regexp.MustCompile(`(?m)^\s*\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+dune\s+`).MatchString(v)
}
func tocFields(v string) []string {
	var out []string
	var current strings.Builder
	quoted, escaped := false, false
	flush := func() {
		if current.Len() > 0 {
			out = append(out, current.String())
			current.Reset()
		}
	}
	for _, r := range v {
		if escaped {
			current.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		if r == '"' {
			quoted = !quoted
			continue
		}
		if !quoted && (r == ' ' || r == '\t') {
			flush()
		} else {
			current.WriteRune(r)
		}
	}
	flush()
	return out
}

func validateRestoreSQLFile(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(b) == 0 || bytes.IndexByte(b, 0) >= 0 {
		return errors.New("generated restore SQL is empty or invalid")
	}
	clean := stripSQLLiterals(string(b))
	tokens := regexp.MustCompile(`[A-Za-z_][A-Za-z_0-9$]*|;`).FindAllString(strings.ToLower(clean), -1)
	statement := []string{}
	check := func() bool {
		if len(statement) < 3 || statement[0] != "create" || statement[1] != "schema" {
			return false
		}
		if statement[2] == "dune" {
			return true
		}
		if len(statement) > 3 && statement[2] == "authorization" && statement[3] == "dune" {
			return true
		}
		return len(statement) > 5 && statement[2] == "if" && statement[3] == "not" && statement[4] == "exists" && statement[5] == "dune"
	}
	for _, token := range tokens {
		if token == ";" {
			if check() {
				return errors.New("generated restore SQL duplicates CREATE SCHEMA dune")
			}
			statement = nil
		} else {
			statement = append(statement, token)
		}
	}
	if check() {
		return errors.New("generated restore SQL duplicates CREATE SCHEMA dune")
	}
	return nil
}

type offlineResult struct {
	Phase, Server, Gateway, Director string
	Running, Desired                 int
	Namespace, Name                  string
}

func validateOfflineFiles(dir string, spec OfflineValidation) error {
	if len(spec.BattlegroupFiles) != 2 || len(spec.WorkloadFiles) != 2 || spec.Namespace == "" || spec.Name == "" {
		return errors.New("exactly two offline samples are required")
	}
	results := make([]offlineResult, 2)
	for i := 0; i < 2; i++ {
		result, err := readOfflineSample(safeJobPath(dir, spec.BattlegroupFiles[i]), safeJobPath(dir, spec.WorkloadFiles[i]))
		if err != nil {
			return err
		}
		if result.Namespace != spec.Namespace || result.Name != spec.Name {
			return errors.New("offline evidence target differs")
		}
		results[i] = result
	}
	a, _ := json.Marshal(results[0])
	b, _ := json.Marshal(results[1])
	if !bytes.Equal(a, b) {
		return errors.New("offline evidence changed between samples")
	}
	r := results[0]
	if !offlinePhase(r.Phase) || !offlineComponent(r.Server) || !offlineComponent(r.Gateway) || !offlineComponent(r.Director) || r.Running != 0 || r.Desired != 0 {
		return errors.New("battlegroup is not authoritatively stopped")
	}
	return nil
}

func readOfflineSample(bgPath, workPath string) (offlineResult, error) {
	var bg map[string]any
	var workloads map[string]any
	bb, err := os.ReadFile(bgPath)
	if err != nil {
		return offlineResult{}, err
	}
	wb, err := os.ReadFile(workPath)
	if err != nil {
		return offlineResult{}, err
	}
	if json.Unmarshal(bb, &bg) != nil || json.Unmarshal(wb, &workloads) != nil {
		return offlineResult{}, errors.New("structured Kubernetes evidence is malformed")
	}
	metadata, ok := bg["metadata"].(map[string]any)
	if !ok {
		return offlineResult{}, errors.New("battlegroup metadata is missing")
	}
	status, ok := bg["status"].(map[string]any)
	if !ok {
		return offlineResult{}, errors.New("battlegroup status is missing")
	}
	utilities, ok := status["utilities"].(map[string]any)
	if !ok {
		return offlineResult{}, errors.New("battlegroup utilities are missing")
	}
	gateway, _ := utilities["serverGateway"].(map[string]any)
	director, _ := utilities["director"].(map[string]any)
	r := offlineResult{Namespace: stringField(metadata, "namespace"), Name: stringField(metadata, "name"), Phase: lowerField(status, "phase"), Server: lowerField(status, "serverGroupPhase"), Gateway: lowerField(gateway, "phase"), Director: lowerField(director, "phase")}
	items, ok := workloads["items"].([]any)
	if !ok {
		return offlineResult{}, errors.New("workload items are missing")
	}
	for _, raw := range items {
		resource, ok := raw.(map[string]any)
		if !ok {
			return offlineResult{}, errors.New("workload item is malformed")
		}
		if !gameResource(resource) {
			continue
		}
		kind := stringField(resource, "kind")
		spec, _ := resource["spec"].(map[string]any)
		if kind == "Pod" {
			status, _ := resource["status"].(map[string]any)
			phase := lowerField(status, "phase")
			if phase == "running" || phase == "pending" || phase == "unknown" {
				r.Running++
			} else if phase != "succeeded" && phase != "failed" {
				return offlineResult{}, errors.New("game pod phase is unknown")
			}
		} else if kind == "Deployment" || kind == "StatefulSet" || kind == "ReplicaSet" {
			replicas, ok := spec["replicas"].(float64)
			if !ok || replicas < 0 || replicas != float64(int(replicas)) {
				return offlineResult{}, errors.New("desired game replicas are malformed")
			}
			r.Desired += int(replicas)
		}
	}
	if r.Namespace == "" || r.Name == "" || r.Phase == "" || r.Server == "" || r.Gateway == "" || r.Director == "" {
		return offlineResult{}, errors.New("required offline fields are missing")
	}
	return r, nil
}

func gameResource(resource map[string]any) bool {
	spec, _ := resource["spec"].(map[string]any)
	kind := stringField(resource, "kind")
	if kind != "Pod" {
		template, _ := spec["template"].(map[string]any)
		spec, _ = template["spec"].(map[string]any)
	}
	containers, _ := spec["containers"].([]any)
	for _, raw := range containers {
		c, _ := raw.(map[string]any)
		image := stringField(c, "image")
		if regexp.MustCompile(`(?i)(^|/)seabass-server(:|@)`).MatchString(image) {
			return true
		}
	}
	return false
}
func stringField(value map[string]any, key string) string {
	v, _ := value[key].(string)
	return strings.TrimSpace(v)
}
func lowerField(value map[string]any, key string) string {
	return strings.ToLower(stringField(value, key))
}
func offlinePhase(v string) bool     { return v == "stopped" || v == "offline" }
func offlineComponent(v string) bool { return v == "stopped" || v == "offline" || v == "suspended" }

func stripSQLLiterals(v string) string {
	var out strings.Builder
	for i := 0; i < len(v); {
		if i+1 < len(v) && v[i:i+2] == "--" {
			for i < len(v) && v[i] != '\n' {
				i++
			}
			out.WriteByte(' ')
			continue
		}
		if i+1 < len(v) && v[i:i+2] == "/*" {
			i += 2
			depth := 1
			for i < len(v) && depth > 0 {
				if i+1 < len(v) && v[i:i+2] == "/*" {
					depth++
					i += 2
				} else if i+1 < len(v) && v[i:i+2] == "*/" {
					depth--
					i += 2
				} else {
					i++
				}
			}
			out.WriteByte(' ')
			continue
		}
		if v[i] == '\'' {
			q := v[i]
			i++
			for i < len(v) {
				if v[i] == q {
					if i+1 < len(v) && v[i+1] == q {
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			out.WriteByte(' ')
			continue
		}
		if v[i] == '"' {
			i++
			for i < len(v) {
				if v[i] == '"' {
					if i+1 < len(v) && v[i+1] == '"' {
						out.WriteByte('"')
						i += 2
						continue
					}
					i++
					break
				}
				out.WriteByte(v[i])
				i++
			}
			continue
		}
		if v[i] == '$' {
			if m := regexp.MustCompile(`^\$[A-Za-z_0-9]*\$`).FindString(v[i:]); m != "" {
				end := strings.Index(v[i+len(m):], m)
				if end < 0 {
					return out.String()
				}
				i += len(m) + end + len(m)
				out.WriteByte(' ')
				continue
			}
		}
		out.WriteByte(v[i])
		i++
	}
	return out.String()
}

func heartbeatLoop(path string, stop <-chan struct{}) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	writeHeartbeat(path)
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			writeHeartbeat(path)
		}
	}
}

func writeHeartbeat(path string) {
	tmp := path + ".next"
	if err := os.WriteFile(tmp, []byte(now()+"\n"), 0600); err == nil {
		_ = os.Rename(tmp, path)
	}
}

func finishFailure(path string, state *State, code, message string) error {
	state.Status = "failed"
	state.Stage = "failed"
	state.Detail = "Migration worker stopped fail-closed"
	state.ErrorCode = code
	state.Error = message
	state.FinishedAt = now()
	state.UpdatedAt = now()
	state.Heartbeat = now()
	_ = writeState(path, state)
	return &workerError{code, message}
}

func writeState(path string, state *State) error {
	state.UpdatedAt = now()
	state.Heartbeat = state.UpdatedAt
	b, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := path + ".next"
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	return os.Rename(tmp, path)
}

func readState(path string) (State, error) {
	var s State
	b, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(b, &s)
	return s, err
}

func loadVerifiedJob(dir string) (Job, string) {
	var job Job
	b, err := os.ReadFile(filepath.Join(dir, "job.json"))
	if err != nil {
		fatal("job_missing", "job description is missing")
	}
	d := sha256.Sum256(b)
	digest := hex.EncodeToString(d[:])
	want, err := os.ReadFile(filepath.Join(dir, "job.json.sha256"))
	if err != nil || strings.TrimSpace(string(want)) != digest {
		fatal("job_hash", "job description hash is invalid")
	}
	sig, err := os.ReadFile(filepath.Join(dir, "job.json.sig"))
	if err != nil {
		fatal("job_signature", "job signature is missing")
	}
	keyPath := productionSigningPublicKeyPath
	if os.Geteuid() != 0 && os.Getenv("ALPHANINE_MIGRATION_TEST_PUBLIC_KEY") != "" {
		keyPath = os.Getenv("ALPHANINE_MIGRATION_TEST_PUBLIC_KEY")
	}
	publicText, keyErr := os.ReadFile(keyPath)
	if keyErr != nil {
		fatal("job_signature", "Suite migration signing key is unavailable")
	}
	pub, err := hex.DecodeString(strings.TrimSpace(string(publicText)))
	if err != nil || len(pub) != ed25519.PublicKeySize || !ed25519.Verify(ed25519.PublicKey(pub), b, sig) {
		fatal("job_signature", "job signature is invalid")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&job); err != nil {
		fatal("job_schema", "job description is malformed")
	}
	if job.Version != jobVersion || job.JobID == "" || job.DestinationCheckpoint == "" || job.RollbackCheckpoint == "" {
		fatal("job_schema", "job description is incomplete")
	}
	return job, digest
}

func verifyAllInputs(dir string, job Job) error {
	if err := verifyFile(dir, job.Package); err != nil {
		return err
	}
	if err := verifyFile(dir, job.Worker); err != nil {
		return err
	}
	for _, f := range job.Inputs {
		if err := verifyFile(dir, f); err != nil {
			return err
		}
	}
	return nil
}

func safeJobPath(dir, name string) string {
	if name == "" || filepath.IsAbs(name) || strings.Contains(name, "..") || strings.ContainsAny(name, "\\\x00") {
		panic("unsafe job path")
	}
	p := filepath.Clean(filepath.Join(dir, name))
	rel, err := filepath.Rel(dir, p)
	if err != nil || strings.HasPrefix(rel, "..") {
		panic("unsafe job path")
	}
	return p
}

func verifyFile(dir string, expected FileIdentity) error {
	if expected.Path == "" || !validDigest(expected.SHA256) {
		return errors.New("file identity is malformed")
	}
	p := safeJobPath(dir, expected.Path)
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	if strconv.FormatInt(n, 10) != expected.Size {
		return fmt.Errorf("file %s size mismatch", expected.Path)
	}
	if hex.EncodeToString(h.Sum(nil)) != strings.ToLower(expected.SHA256) {
		return fmt.Errorf("file %s hash mismatch", expected.Path)
	}
	return nil
}

func fileIdentity(dir, name string) (FileIdentity, error) {
	p := safeJobPath(dir, name)
	f, err := os.Open(p)
	if err != nil {
		return FileIdentity{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return FileIdentity{}, err
	}
	return FileIdentity{Path: name, Size: strconv.FormatInt(n, 10), SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}

func validDigest(v string) bool {
	if len(v) != 64 {
		return false
	}
	_, err := hex.DecodeString(v)
	return err == nil
}
