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
			CategoryMask:   65536,
			CategoryDepth:  2,
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
		"grant select on sequence public.alphanine_market_bot_audit_id_seq to dune",
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("migration does not preserve database backup access: missing %q", expected)
		}
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
