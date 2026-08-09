package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testConfig() Config {
	cfg := Config{
		SchemaVersion:     2,
		RuntimeVersion:    runtimeVersion,
		ConfigGeneration:  "900719925474099312345678901234567890",
		PauseGeneration:   "900719925474099312345678901234567889",
		ConfigFingerprint: "",
		Enabled:           true,
		Activated:         true,
		Battlegroup:       "abc",
		Namespace:         "dune-abc",
		DBPod:             "database-0",
		DBService:         "database",
		IntervalMinutes:   30,
		ExpiryDays:        3,
		Safety: SafetyConfig{
			MaxCreatesPerCycle: 10,
			MaxMarketValue:     1000000,
		},
		Items: []ItemPolicy{{
			ID:             "Item_Test",
			Name:           "Test Item",
			Category:       "Misc",
			Enabled:        true,
			UnitPrice:      100,
			StackSize:      2,
			TargetListings: 3,
			CategoryMask:   65536,
			CategoryDepth:  2,
		}},
	}
	fingerprint, err := canonicalConfigFingerprint(cfg)
	if err != nil {
		panic(err)
	}
	cfg.ConfigFingerprint = fingerprint
	return cfg
}

func TestPauseMarkerPreventsNewCycleLease(t *testing.T) {
	root := t.TempDir()
	p := paths{pauseMarker: filepath.Join(root, "pause-requested"), cycleLease: filepath.Join(root, "cycle-running")}
	if err := ensurePauseMarker(p.pauseMarker); err != nil {
		t.Fatalf("pause marker failed: %v", err)
	}
	if err := acquireCycleLease(p); err == nil {
		t.Fatal("cycle lease was acquired after pause request")
	}
	if err := clearPauseMarker(p.pauseMarker); err != nil {
		t.Fatalf("pause marker clear failed: %v", err)
	}
	if err := acquireCycleLease(p); err != nil {
		t.Fatalf("cycle lease failed while running: %v", err)
	}
	if err := ensurePauseMarker(p.pauseMarker); err != nil {
		t.Fatalf("concurrent pause marker failed: %v", err)
	}
	if err := acquireCycleLease(p); err == nil {
		t.Fatal("a second cycle started while draining")
	}
	releaseCycleLease(p.cycleLease)
}

func TestGenerationComparisonBeyondJavaScriptSafeIntegers(t *testing.T) {
	if !validGeneration("900719925474099312345678901234567890") {
		t.Fatal("large decimal generation was rejected")
	}
	if compareGeneration("900719925474099312345678901234567891", "900719925474099312345678901234567890") <= 0 {
		t.Fatal("large monotonic generation comparison failed")
	}
	if validGeneration("1.5") || validGeneration("-1") {
		t.Fatal("non-decimal generation was accepted")
	}
}

func TestConfigValidation(t *testing.T) {
	cfg := testConfig()
	if err := validateConfig(cfg); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	cfg.Items[0].UnitPrice = 0
	if err := validateConfig(cfg); err == nil {
		t.Fatal("unsafe zero price was accepted")
	}
}

func TestPreviewUsesReadOnlyProductionPlanner(t *testing.T) {
	sql := reconciliationSQL(testConfig(), "preview-test", false)
	for _, expected := range []string{
		"pg_try_advisory_xact_lock",
		"public.alphanine_market_bot_listings",
		"target_count-coalesce(a.active,0)",
		"extract(epoch from clock_timestamp())",
		"'database-clock'",
		"'clockSource'",
		"'warning','Only category-verified listings count as active",
		"o.category_mask>0 and o.category_depth>0",
		"partition by lower(e.category)",
		"order by e.category_sequence,lower(e.category)",
		"rollback;",
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("preview SQL missing %q", expected)
		}
	}
	if strings.Contains(sql, "insert into dune.items") {
		t.Fatal("preview planner contains listing writes")
	}
}

func TestExecuteIsOwnedLockedAndIdempotent(t *testing.T) {
	sql := reconciliationSQL(testConfig(), "execute-test", true)
	for _, expected := range []string{
		"pg_try_advisory_xact_lock",
		"prior_cycle",
		"on conflict do nothing",
		"class='Duke' and owner_account_id is null",
		"extract(epoch from clock_timestamp())",
		"from public.alphanine_market_bot_listings",
		"o.is_npc_order=true",
		"insert into dune.items",
		"p.category_mask,p.category_depth",
		"o.category_mask<=0 or o.category_depth<=0",
		"partition by lower(e.category)",
		"insert into public.alphanine_market_bot_listings",
		"completed_at,result",
		"commit;",
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("execution SQL missing %q", expected)
		}
	}
	if strings.Contains(sql, "o.is_npc_order = false") {
		t.Fatal("execution planner contains a player-listing mutation predicate")
	}
}

func TestCleanupDeletesOnlyStrictlyTrackedBotOwnedListings(t *testing.T) {
	sql := cleanupSQL(testConfig())
	for _, expected := range []string{
		"pg_try_advisory_xact_lock",
		"public.alphanine_market_bot_listings",
		"m.retired_at is null",
		"class='Duke' and owner_account_id is null",
		"join bot_actor b on b.id=o.owner_id",
		"o.is_npc_order=true",
		"delete from dune.dune_exchange_sell_orders",
		"delete from dune.dune_exchange_orders",
		"delete from dune.items",
		"'playerListingsChanged',0",
		"commit;",
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("cleanup SQL missing %q", expected)
		}
	}
	if strings.Contains(sql, "o.is_npc_order=false") || strings.Contains(sql, "o.is_npc_order = false") {
		t.Fatal("cleanup SQL contains a player-listing predicate")
	}
}

func TestSQLTextEscapesCatalogValues(t *testing.T) {
	cfg := testConfig()
	cfg.Items[0].Name = "Maker's Knife"
	sql := reconciliationSQL(cfg, "cycle'one", false)
	if !strings.Contains(sql, "Maker''s Knife") || !strings.Contains(sql, "cycle''one") {
		t.Fatal("SQL catalog values were not escaped")
	}
}

func TestMigrationCreatesNativeTrackedBotIdentity(t *testing.T) {
	sql := migrationSQL()
	if !strings.Contains(sql, "select 'Duke'") || !strings.Contains(sql, "owner_account_id is null") {
		t.Fatal("migration does not create a clean native Duke actor")
	}
	if !strings.Contains(sql, "from public.alphanine_market_bot_listings m") || !strings.Contains(sql, "set owner_id=(select id from selected_duke)") {
		t.Fatal("migration does not transfer only tracked legacy bot listings")
	}
	if !strings.Contains(sql, "create table if not exists public.alphanine_market_bot_listings") {
		t.Fatal("migration does not create listing ownership metadata")
	}
	for _, expected := range []string{
		"grant usage on schema public to dune",
		"grant select on table",
		"public.alphanine_market_bot_cycles",
		"public.alphanine_market_bot_listings",
		"public.alphanine_market_bot_audit",
		"public.alphanine_market_bot_cycle_evidence",
		"grant select on sequence public.alphanine_market_bot_audit_id_seq to dune",
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("migration does not preserve database backup access: missing %q", expected)
		}
	}
}

func TestCycleEvidenceUsesSeparateWallClockTransitions(t *testing.T) {
	cfg := testConfig()
	for _, event := range []string{"queued", "started", "transaction_committed", "failed", "completed"} {
		sql := cycleEvidenceSQL(cfg, "cycle-evidence", event)
		if !strings.Contains(sql, "clock_timestamp()") {
			t.Fatalf("%s evidence does not use a real wall clock", event)
		}
	}
	failed := cycleEvidenceSQL(cfg, "cycle-evidence", "failed")
	if !strings.Contains(failed, "failure_kind='rolled_back'") || !strings.Contains(failed, "failed_at=clock_timestamp()") {
		t.Fatal("failure evidence does not distinguish rollback from completion")
	}
	committed := cycleEvidenceSQL(cfg, "cycle-evidence", "transaction_committed")
	if !strings.Contains(committed, "transaction_committed_at=clock_timestamp()") {
		t.Fatal("transaction commit evidence is missing")
	}
}

func TestRuntimeQuiescenceEvidenceIsStableAndFailClosed(t *testing.T) {
	sql := runtimeQuiescenceSQL()
	for _, expected := range []string{
		"pg_locks", "locktype='advisory'", "alphanine_market_bot_cycle_evidence",
		"completed_at is null", "unexpectedWriters", "openTransactions", "pg_stat_activity",
		"activeTracking", "trackingDigest", "protectedDigest",
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("quiescence evidence missing %q", expected)
		}
	}
}

func provenState(t *testing.T, p paths, cfg Config, now time.Time) State {
	t.Helper()
	fingerprint, err := currentRuntimeFingerprint()
	if err != nil {
		t.Fatalf("runtime fingerprint failed: %v", err)
	}
	if err := ensurePauseMarker(p.pauseMarker); err != nil {
		t.Fatalf("pause marker failed: %v", err)
	}
	state := stateForConfigAt(cfg, "Quiescent", "proven", nil, now)
	state.RuntimeFingerprint = fingerprint
	state.ConfigFingerprint = cfg.ConfigFingerprint
	state.ProofedAt = now.Format(time.RFC3339Nano)
	return state
}

func TestSuccessfulPeriodicRevalidationKeepsQuiescentPublished(t *testing.T) {
	root := t.TempDir()
	p := paths{state: filepath.Join(root, "state.json"), pauseMarker: filepath.Join(root, "pause"), cycleLease: filepath.Join(root, "lease")}
	cfg := testConfig()
	cfg.Paused = true
	cfg.ConfigGeneration = "6"
	cfg.PauseGeneration = "6"
	now := time.Now().UTC()
	previous := provenState(t, p, cfg, now)
	if err := writeAtomicJSON(p.state, previous, 0640); err != nil {
		t.Fatalf("state setup failed: %v", err)
	}
	fingerprint := previous.RuntimeFingerprint
	proofStarted := make(chan struct{})
	releaseProof := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		close(proofStarted)
		<-releaseProof
		next := pausedVerificationPublication(previous, cfg, fingerprint, json.RawMessage(`{"advisoryLocks":"0","incompleteCycles":"0","unexpectedWriters":"0","openTransactions":"0"}`), nil, now.Add(time.Second))
		_ = writeAtomicJSON(p.state, next, 0640)
		close(finished)
	}()
	<-proofStarted
	var wait sync.WaitGroup
	for index := 0; index < 24; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			state, err := readState(p.state)
			if err != nil {
				t.Errorf("concurrent status read failed: %v", err)
				return
			}
			status := statusStateForRead(p, cfg, state, now.Add(500*time.Millisecond))
			if status.Status != "Quiescent" || status.PauseState != "Quiescent" {
				t.Errorf("status reader observed artificial transition: %#v", status)
			}
		}()
	}
	wait.Wait()
	close(releaseProof)
	<-finished
	after, _ := readState(p.state)
	if after.Status != "Quiescent" || after.ProofedAt == previous.ProofedAt {
		t.Fatal("successful periodic proof did not refresh the Quiescent publication")
	}
}

func TestPeriodicRevalidationFailsClosedOnIdentityDrift(t *testing.T) {
	cfg := testConfig()
	cfg.Paused = true
	cfg.ConfigGeneration = "6"
	cfg.PauseGeneration = "6"
	now := time.Now().UTC()
	p := paths{pauseMarker: filepath.Join(t.TempDir(), "pause"), cycleLease: filepath.Join(t.TempDir(), "lease")}
	previous := provenState(t, p, cfg, now)
	for name, mutate := range map[string]func(*Config, *string){
		"generation":                func(next *Config, _ *string) { next.ConfigGeneration, next.PauseGeneration = "7", "7" },
		"configuration fingerprint": func(next *Config, _ *string) { next.ConfigFingerprint = strings.Repeat("d", 64) },
		"runtime fingerprint":       func(_ *Config, fingerprint *string) { *fingerprint = strings.Repeat("e", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			next := cfg
			fingerprint := previous.RuntimeFingerprint
			mutate(&next, &fingerprint)
			published := pausedVerificationPublication(previous, next, fingerprint, json.RawMessage(`{}`), nil, now.Add(time.Second))
			if published.Status != "Draining" || !published.IncompleteCycle {
				t.Fatalf("identity drift did not publish fail-closed state: %#v", published)
			}
		})
	}
}

func TestPeriodicRevalidationFailureAndStalenessFailClosed(t *testing.T) {
	cfg := testConfig()
	cfg.Paused = true
	cfg.ConfigGeneration, cfg.PauseGeneration = "6", "6"
	now := time.Now().UTC()
	p := paths{pauseMarker: filepath.Join(t.TempDir(), "pause"), cycleLease: filepath.Join(t.TempDir(), "lease")}
	previous := provenState(t, p, cfg, now)
	for _, failure := range []error{context.DeadlineExceeded, errors.New("transport failure")} {
		published := pausedVerificationPublication(previous, cfg, previous.RuntimeFingerprint, nil, failure, now.Add(time.Second))
		if published.Status != "Draining" || !published.IncompleteCycle {
			t.Fatalf("verification failure was retained as Quiescent: %#v", published)
		}
	}
	stale := statusStateForRead(p, cfg, previous, now.Add(quiescenceProofFreshness+time.Nanosecond))
	if stale.Status != "Unknown" || !stale.IncompleteCycle {
		t.Fatalf("stale proof did not expire fail-closed: %#v", stale)
	}
}

func TestRuntimeActivityEvidenceAndLeaseFailClosed(t *testing.T) {
	base := map[string]string{"advisoryLocks": "0", "incompleteCycles": "0", "unexpectedWriters": "0", "openTransactions": "0"}
	for _, field := range []string{"advisoryLocks", "incompleteCycles", "unexpectedWriters", "openTransactions"} {
		sample := map[string]string{}
		for key, value := range base {
			sample[key] = value
		}
		sample[field] = "1"
		raw, _ := json.Marshal(sample)
		if validateRuntimeQuiescenceSample(raw) == nil {
			t.Fatalf("%s activity was accepted", field)
		}
	}
	cfg := testConfig()
	cfg.Paused = true
	cfg.ConfigGeneration, cfg.PauseGeneration = "6", "6"
	root := t.TempDir()
	p := paths{pauseMarker: filepath.Join(root, "pause"), cycleLease: filepath.Join(root, "lease")}
	now := time.Now().UTC()
	state := provenState(t, p, cfg, now)
	if err := os.WriteFile(p.cycleLease, []byte("held"), 0600); err != nil {
		t.Fatal(err)
	}
	status := statusStateForRead(p, cfg, state, now.Add(time.Second))
	if status.Status != "Draining" || !status.IncompleteCycle {
		t.Fatalf("cycle lease did not invalidate Quiescent status: %#v", status)
	}
}

func TestPausedDaemonDoesNotPublishRequestedBeforeProof(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if strings.Contains(text, `requested := stateForConfig(cfg, "Pause requested", "Pause is persisted; proving the runtime and database are quiescent.", nil)`) {
		t.Fatal("paused daemon still publishes Pause requested before periodic proof")
	}
	if !strings.Contains(text, "previous, _ := readState(p.state)") || !strings.Contains(text, "pausedVerificationPublication(previous") {
		t.Fatal("paused daemon does not preserve the prior publication during proof")
	}
}

func TestKubectlCallsHaveBoundedTimeouts(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("could not read bot source: %v", err)
	}
	text := string(source)
	for _, expected := range []string{
		"context.WithTimeout",
		`"timeout", "-k", "5", "20", "kubectl"`,
		`"timeout", "-k", "5", "120", "kubectl"`,
		"database planner timed out",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("bounded kubectl execution missing %q", expected)
		}
	}
}
