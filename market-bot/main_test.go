package main

import (
	"os"
	"strings"
	"testing"
)

func testConfig() Config {
	return Config{
		SchemaVersion:   1,
		RuntimeVersion:  "test",
		Enabled:         true,
		Activated:       true,
		Battlegroup:     "abc",
		Namespace:       "dune-abc",
		DBPod:           "database-0",
		DBService:       "database",
		IntervalMinutes: 30,
		ExpiryDays:      3,
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
		}},
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
		"'warning','Active listings are never repriced",
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
		"properties->>'AlphaNineOwner'='market-bot-v1'",
		"extract(epoch from clock_timestamp())",
		"from public.alphanine_market_bot_listings",
		"o.is_npc_order=true",
		"insert into dune.items",
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

func TestSQLTextEscapesCatalogValues(t *testing.T) {
	cfg := testConfig()
	cfg.Items[0].Name = "Maker's Knife"
	sql := reconciliationSQL(cfg, "cycle'one", false)
	if !strings.Contains(sql, "Maker''s Knife") || !strings.Contains(sql, "cycle''one") {
		t.Fatal("SQL catalog values were not escaped")
	}
}

func TestMigrationCreatesStrictOwnershipMarker(t *testing.T) {
	sql := migrationSQL()
	if !strings.Contains(sql, `"AlphaNineOwner":"market-bot-v1"`) {
		t.Fatal("migration does not create the dedicated ownership marker")
	}
	if !strings.Contains(sql, "create table if not exists public.alphanine_market_bot_listings") {
		t.Fatal("migration does not create listing ownership metadata")
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
